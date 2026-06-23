import sys
import json
import os
import re
from pypdf import PdfReader
import chromadb

def chunk_text(text, target_size=1000, overlap=200):
    if len(text) <= target_size:
        return [text]

    chunks = []
    start = 0

    while start < len(text):
        end = start + target_size
        if end >= len(text):
            chunks.append(text[start:])
            break

        # Look for paragraph boundary (\n\n) or sentence boundary in the overlap region
        search_start = max(start + 50, end - overlap)
        slice_text = text[search_start:end + 100]

        split_idx = -1
        p_match = slice_text.rfind('\n\n')
        if p_match != -1:
            split_idx = search_start + p_match + 2
        else:
            # Find sentence boundary: . or ? or ! followed by space
            s_match = re.search(r'[.!?]\s', slice_text)
            if s_match is not None and search_start + s_match.end() <= end:
                split_idx = search_start + s_match.end()
            else:
                # Try simple newline
                n_match = slice_text.rfind('\n')
                if n_match != -1:
                    split_idx = search_start + n_match + 1

        # If no boundary found, split at end
        if split_idx == -1 or split_idx <= start:
            split_idx = end

        chunks.append(text[start:split_idx].strip())
        next_start = split_idx - overlap
        start = next_start if next_start > start else split_idx

    return [c for c in chunks if len(c) > 0]

def extract_text_from_pdf(file_path):
    reader = PdfReader(file_path)
    text_parts = []
    for page in reader.pages:
        t = page.extract_text()
        if t:
            text_parts.append(t)
    return "\n\n".join(text_parts)

def extract_text_from_file(file_path):
    if file_path.lower().endswith('.pdf'):
        return extract_text_from_pdf(file_path)
    else:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read()

def main():
    try:
        # Load configuration from stdin
        config = json.loads(sys.stdin.read())
        collection_id = config['collectionId']
        message_id = config['messageId']
        attachments = config['attachments']

        print(f"[embed_helper] Ingesting {len(attachments)} attachments for collection {collection_id}")

        # Connect to Chroma
        client = chromadb.HttpClient(host="host.docker.internal", port=8000)
        collection = client.get_or_create_collection(name=collection_id)

        for attachment in attachments:
            file_path = os.path.join('/workspace', attachment['localPath'])
            if not os.path.exists(file_path):
                print(f"[embed_helper] WARNING: File not found: {file_path}", file=sys.stderr)
                continue

            print(f"[embed_helper] Reading file {attachment['name']}")
            text = extract_text_from_file(file_path)
            chunks = chunk_text(text)

            if not chunks:
                print(f"[embed_helper] WARNING: No text chunks extracted from {attachment['name']}", file=sys.stderr)
                continue

            print(f"[embed_helper] Split {attachment['name']} into {len(chunks)} chunks. Uploading...")

            ids = [f"{message_id}-{attachment['name']}-{i}" for i in range(len(chunks))]
            documents = chunks
            metadatas = [{
                "source": attachment['name'],
                "messageId": message_id,
                "chunkIndex": i,
                "totalChunks": len(chunks)
            } for i in range(len(chunks))]

            collection.add(
                ids=ids,
                documents=documents,
                metadatas=metadatas
            )
            print(f"[embed_helper] Successfully added {len(chunks)} chunks of {attachment['name']} to Chroma.")

        print("[embed_helper] Embedding completion successful")
        sys.exit(0)
    except Exception as e:
        print(f"[embed_helper] ERROR: {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
