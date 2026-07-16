import { spawn } from 'child_process';
import { writeMessageOut } from './db/messages-out.js';

interface EmbedFileOptions {
  attachments?: Array<{
    name: string;
    localPath: string;
    size?: number;
    mimeType?: string;
  }>;
  collectionId: string;
  originalEvent: any;
  action?: 'embed_file' | 'embed_news';
  report?: any;
  articles?: any[];
}

export async function embedFile(opts: EmbedFileOptions): Promise<void> {
  const { attachments, collectionId, originalEvent, action = 'embed_file', report, articles } = opts;
  const messageId = originalEvent.message.id;

  console.log(`[embedder] Launching embedding process for action=${action} collection=${collectionId}...`);

  return new Promise<void>((resolve, reject) => {
    // Spawn the Python process with uv run, resolving dependencies on the fly
    const child = spawn('uv', [
      'run',
      '--with', 'pypdf',
      '--with', 'chromadb',
      'python',
      '/app/src/embed_helper.py'
    ]);

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('close', (code) => {
      if (stdoutData.trim()) {
        console.log(`[embedder] stdout:\n${stdoutData}`);
      }
      if (stderrData.trim()) {
        console.error(`[embedder] stderr:\n${stderrData}`);
      }

      if (code !== 0) {
        reject(new Error(`Python embed_helper.py failed with exit code ${code}`));
      } else {
        // Write the completion message to the outbound DB once finished
        console.log(`[embedder] All files embedded successfully. Writing file_embedded_success message to messages_out.`);
        const outMsgId = `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeMessageOut({
          id: outMsgId,
          kind: 'system',
          content: JSON.stringify({
            action: 'file_embedded_success',
            originalEvent,
          }),
        });
        resolve();
      }
    });

    // Write the configuration payload to the script's stdin
    const payload = JSON.stringify({
      action,
      collectionId,
      messageId,
      attachments,
      report,
      articles,
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}
