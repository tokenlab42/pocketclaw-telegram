import { getDb, hasTable } from '../../db/connection.js';
import { getPendingFileMessage, deletePendingFileMessage, getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { routeInbound } from '../../router.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { Session } from '../../types.js';
import { registerDeliveryAction, getDeliveryAdapter } from '../../delivery.js';

async function handleFileMemoryChoice(payload: ResponsePayload): Promise<boolean> {
  if (!payload.questionId.startsWith('file-')) return false;
  if (!hasTable(getDb(), 'pending_file_messages')) return false;

  const pfm = getPendingFileMessage(payload.questionId);
  if (!pfm) return false;

  const originalEvent = JSON.parse(pfm.original_message) as InboundEvent;

  deletePendingFileMessage(payload.questionId);

  if (payload.value === 'short-term') {
    log.info('File memory choice: short-term context. Re-routing message.', { questionId: payload.questionId });
    // Re-route with bypass flag
    void routeInbound({
      ...originalEvent,
      bypassFileMemoryInterceptor: true,
    }).catch((err) => {
      log.error('Failed to route short-term file message', { err });
    });
    return true;
  }

  if (payload.value === 'cancel') {
    log.info('File memory choice: cancelled.', { questionId: payload.questionId });
    const mg = getMessagingGroupByPlatform(pfm.channel_type, pfm.platform_id);
    if (mg) {
      const agents = getMessagingGroupAgents(mg.id);
      for (const agent of agents) {
        let effectiveSessionMode = agent.session_mode;
        const { getChannelAdapter } = await import('../../channels/channel-registry.js');
        const adapter = originalEvent.channelType ? getChannelAdapter(originalEvent.channelType) : null;
        if (adapter?.supportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
          effectiveSessionMode = 'per-thread';
        }
        const { session } = resolveSession(agent.agent_group_id, mg.id, originalEvent.threadId, effectiveSessionMode);
        writeSessionMessage(session.agent_group_id, session.id, {
          id: `sys-embed-cancel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          platformId: originalEvent.platformId,
          channelType: originalEvent.channelType,
          threadId: originalEvent.threadId,
          content: JSON.stringify({
            text: '[Upload cancelled]',
            sender: 'system',
            senderId: 'system',
          }),
          trigger: 0,
        });
      }
    }
    return true;
  }

  if (payload.value === 'long-term') {
    log.info('File memory choice: long-term memory. Embedding files.', { questionId: payload.questionId });

    const mg = getMessagingGroupByPlatform(pfm.channel_type, pfm.platform_id);
    if (!mg) {
      log.error('Messaging group not found for pending file message', { pfm });
      return true;
    }

    const agents = getMessagingGroupAgents(mg.id);
    for (const agent of agents) {
      const agentGroup = getAgentGroup(agent.agent_group_id);
      if (!agentGroup) continue;

      let effectiveSessionMode = agent.session_mode;
      const { getChannelAdapter } = await import('../../channels/channel-registry.js');
      const adapter = originalEvent.channelType ? getChannelAdapter(originalEvent.channelType) : null;
      if (adapter?.supportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
        effectiveSessionMode = 'per-thread';
      }

      const { session } = resolveSession(agent.agent_group_id, mg.id, originalEvent.threadId, effectiveSessionMode);

      const parsed = JSON.parse(originalEvent.message.content);

      // Write the system command message. This will write files to inbox and wake the container.
      writeSessionMessage(session.agent_group_id, session.id, {
        id: `embed-${originalEvent.message.id}`,
        kind: 'system',
        timestamp: new Date().toISOString(),
        platformId: originalEvent.platformId,
        channelType: originalEvent.channelType,
        threadId: originalEvent.threadId,
        content: JSON.stringify({
          action: 'embed_file',
          attachments: parsed.attachments,
          collectionId: agentGroup.chroma_collection_id || agentGroup.id,
          originalEvent,
        }),
        trigger: 1,
      });

      const freshSession = getSession(session.id);
      if (freshSession) {
        await wakeContainer(freshSession);
      }
    }

    return true;
  }

  return false;
}

registerResponseHandler(handleFileMemoryChoice);

async function handleFileEmbeddedSuccess(content: Record<string, unknown>, session: Session): Promise<void> {
  log.info('Handling file_embedded_success system action', { sessionId: session.id });

  const originalEvent = content.originalEvent as InboundEvent;
  if (!originalEvent) {
    log.error('Missing originalEvent in file_embedded_success action');
    return;
  }

  // 1. Route the original message back into the system, bypassing the file memory interceptor
  await routeInbound({
    ...originalEvent,
    bypassFileMemoryInterceptor: true,
  });

  // 2. Extract attachment names to write the confirmation message
  const parsedContent = JSON.parse(originalEvent.message.content);
  const attachments = parsedContent.attachments || [];
  const names = attachments.map((a: any) => a.name).join(', ');
  const fileWord = attachments.length > 1 ? 'files' : 'file';
  const sysText = `[System: The ${fileWord} ${names} has been successfully chunked and embedded in your long-term memory (Chroma)]`;

  // 3. Write confirmation message to the session's inbound DB
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-embed-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: originalEvent.platformId,
    channelType: originalEvent.channelType,
    threadId: originalEvent.threadId,
    content: JSON.stringify({
      text: sysText,
      sender: 'system',
      senderId: 'system',
    }),
    trigger: 1, // trigger=1 ensures we wake the container and Claude responds
  });

  // 4. Wake the container
  const freshSession = getSession(session.id);
  if (freshSession) {
    await wakeContainer(freshSession);
  }
}

registerDeliveryAction('file_embedded_success', handleFileEmbeddedSuccess);

async function handleFileEmbeddedFailure(content: Record<string, unknown>, session: Session): Promise<void> {
  const errMsg = (content.error as string) || 'Unknown error';
  log.error('Handling file_embedded_failure system action', { sessionId: session.id, error: errMsg });

  const originalEvent = content.originalEvent as InboundEvent;
  if (!originalEvent) {
    log.error('Missing originalEvent in file_embedded_failure action');
    return;
  }

  const deliveryAdapter = getDeliveryAdapter();
  if (!deliveryAdapter) {
    log.error('No delivery adapter found to send failure card');
    return;
  }

  const questionId = `file-fail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const options = [
    { label: '💬 Read as Short-Term Context', value: 'short-term' },
    { label: '❌ Cancel Upload', value: 'cancel' },
  ];
  const title = 'Embedding Failed';
  const question = `Failed to store your file in long-term memory: ${errMsg}. How would you like to proceed?`;

  // 1. Deliver the options card to the user
  await deliveryAdapter.deliver(
    originalEvent.channelType,
    originalEvent.platformId,
    originalEvent.threadId,
    'chat-sdk',
    JSON.stringify({
      type: 'ask_question',
      questionId,
      title,
      question,
      options,
    }),
  );

  // 2. Persist to pending_file_messages table so we can retrieve originalEvent on response
  const { createPendingFileMessage } = await import('../../db/sessions.js');
  const { normalizeOptions } = await import('../../channels/ask-question.js');
  createPendingFileMessage({
    question_id: questionId,
    channel_type: originalEvent.channelType,
    platform_id: originalEvent.platformId,
    thread_id: originalEvent.threadId || null,
    user_id: null,
    title,
    options: normalizeOptions(options),
    original_message: JSON.stringify(originalEvent),
    created_at: new Date().toISOString(),
  });
}

registerDeliveryAction('file_embedded_failure', handleFileEmbeddedFailure);
