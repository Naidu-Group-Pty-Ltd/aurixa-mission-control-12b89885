#!/usr/bin/env python3
"""Upload the committed knowledge base to VAPI, and record what the store holds.

`build-knowledge-doc.mjs --check` fails whenever the committed corpus is not
the copy recorded in knowledge-base/vapi-file.json as uploaded, and names the
remedy. This is that remedy, done the way vapi-file.json says it must be:

- As text/plain with a .txt name. VAPI's store accepts text/markdown, keeps
  the bytes, and then marks the file `failed` with no parsed text - and a
  failed file binds to a query tool exactly like a good one.
- Judged by the store's own `status`, polled until it reads `done` or
  `failed`, never by the upload's HTTP 201.
- Recorded only once the store says `done`: the new id, and the bytes, MD5 and
  SHA-256 of exactly what was sent. The id it replaces becomes
  `previous_file_id` - the corpus to roll back to - but only if that one had
  parsed, because a failed file is not a rollback.

Nothing live changes here. Every assistant keeps querying the old file until
apply-fleet-upgrade.py re-points it at the id recorded here, so the upload can
happen ahead of the rest of a release.

  --dry-run   say what would be uploaded; upload nothing, write nothing
"""
import datetime
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = "https://api.vapi.ai"
S = os.path.dirname(os.path.abspath(__file__))
MD_PATH = os.path.join(S, "knowledge-base", "aurixa-voice-knowledge-base.md")
RECORD_PATH = os.path.join(S, "knowledge-base", "vapi-file.json")
UPLOAD_NAME = "aurixa-voice-knowledge-base.txt"
MIMETYPE = "text/plain"

DRY_RUN = "--dry-run" in sys.argv
POLL_SECONDS = 2
POLL_LIMIT_SECONDS = 180


def request(method, path, key, body=None, content_type="application/json"):
    req = urllib.request.Request(
        BASE + path,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": content_type,
            "User-Agent": "curl/8.5.0",
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} -> {e.code}: {e.read().decode()[:300]}")


def multipart(field, filename, mimetype, content):
    boundary = f"----aurixa-{uuid.uuid4().hex}"
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        f"Content-Type: {mimetype}\r\n\r\n"
    ).encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    return head + content + tail, f"multipart/form-data; boundary={boundary}"


def main():
    with open(MD_PATH, "rb") as f:
        content = f.read()
    with open(RECORD_PATH) as f:
        record = json.load(f)

    sha256 = hashlib.sha256(content).hexdigest()
    md5 = hashlib.md5(content).hexdigest()
    if record.get("file_id") and record.get("sha256") == sha256:
        print(f"already uploaded: file {record['file_id']} is this corpus (sha256 {sha256})")
        return

    print(f"to upload: {len(content)} bytes, sha256 {sha256}, as {UPLOAD_NAME} ({MIMETYPE})")
    print(f"replacing: file {record.get('file_id')} (sha256 {record.get('sha256')})")
    if DRY_RUN:
        print("dry run: nothing uploaded, nothing written")
        return

    key = os.environ["VAPI_KEY"]
    body, content_type = multipart("file", UPLOAD_NAME, MIMETYPE, content)
    uploaded = request("POST", "/file", key, body, content_type)
    file_id = uploaded["id"]
    print(f"uploaded as {file_id}; waiting for the store to parse it")

    status = uploaded.get("status")
    waited = 0
    while status not in ("done", "failed") and waited < POLL_LIMIT_SECONDS:
        time.sleep(POLL_SECONDS)
        waited += POLL_SECONDS
        status = request("GET", f"/file/{file_id}", key).get("status")

    if status != "done":
        print(
            f"NOT RECORDED: the store says file {file_id} is {status or 'unknown'} after "
            f"{waited}s. The fleet is unchanged and still reads {record.get('file_id')}. "
            "Delete the failed file in the VAPI dashboard, and check the upload was text/plain."
        )
        sys.exit(1)

    previous = record.get("file_id") if record.get("status") == "done" else record.get("previous_file_id")
    record.update(
        {
            "file_id": file_id,
            "uploaded_as": UPLOAD_NAME,
            "mimetype": MIMETYPE,
            "status": "done",
            "uploaded_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "bytes": len(content),
            "md5": md5,
            "sha256": sha256,
            "previous_file_id": previous,
        }
    )
    with open(RECORD_PATH, "w") as f:
        json.dump(record, f, indent=2)
        f.write("\n")
    print(f"recorded {file_id} in {RECORD_PATH} (previous {previous})")
    print("next: python3 scripts/voice/apply-fleet-upgrade.py to point the fleet at it")


if __name__ == "__main__":
    main()
