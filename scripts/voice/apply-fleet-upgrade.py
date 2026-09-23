#!/usr/bin/env python3
"""Apply the comprehensive prompts + org-level toolIds to the 12 MC assistants.

Per assistant: GET fresh -> replace the system message with the generated
prompt, bind the role's org tools from the manifest, leave every inline tool
alone -> PATCH -> verify.
Model (gpt-5.6-luna), voice, firstMessage, server, transcriber untouched.

A VAPI PATCH replaces a whole top-level key, so `model` is always read fresh
and sent back entire. Inline tools are never filtered: an earlier version kept
only the knowledge-base query tool and deleted everything else, which is how
the end-call tool came to be missing from all twelve assistants.

The knowledge base travels too: knowledge-base/vapi-file.json records which
VAPI file the corpus was uploaded as, and every inline `query` tool is pointed
at it and verified by read-back. A null file id there means the corpus is not
managed from here and every query tool is left exactly as found.

  --prune-unmanaged   make the manifest exclusive: drop bound toolIds it does
                      not name. Off by default, because dropping a binding
                      silently is the defect this script already shipped.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

KEY = os.environ["VAPI_KEY"]
BASE = "https://api.vapi.ai"
S = os.path.dirname(os.path.abspath(__file__))

PRUNE_UNMANAGED = "--prune-unmanaged" in sys.argv

TOOL_IDS = json.load(open(os.path.join(S, "fleet-prompts", "mc_org_tool_ids.json")))
MANIFEST = json.load(open(os.path.join(S, "fleet-prompts", "manifest.json")))
KB = json.load(open(os.path.join(S, "knowledge-base", "vapi-file.json")))
KB_FILE_ID = KB.get("file_id")


def repoint_knowledge_base(model):
    """Point this assistant at the recorded knowledge-base file.

    VAPI stores the file id in TWO places on an assistant - the inline `query`
    tool's `knowledgeBases[].fileIds`, and `model.knowledgeBase.fileIds` - and
    both were carrying the same id on all twelve when this was measured.
    Updating one and not the other leaves an assistant naming two different
    corpora, which is a worse state than the stale one it started in, so both
    are written together or neither is.

    The knowledge base used to reach the fleet by hand: build the document,
    upload it to VAPI, then edit twelve assistants to name the new file id.
    Nothing recorded which id was live, so nobody could tell a fleet answering
    from last month's corpus from one answering from this month's.

    A null `file_id` means the corpus is not managed here, and then this does
    nothing at all rather than guessing - unbinding a knowledge base leaves
    every assistant answering from nothing, which is worse than a stale one.
    """
    if not KB_FILE_ID:
        return 0
    changed = 0
    for t in model.get("tools") or []:
        if t.get("type") != "query":
            continue
        for kb in t.get("knowledgeBases") or []:
            if kb.get("fileIds") != [KB_FILE_ID]:
                kb["fileIds"] = [KB_FILE_ID]
                changed += 1
    kb = model.get("knowledgeBase")
    if isinstance(kb, dict) and kb.get("fileIds") != [KB_FILE_ID]:
        kb["fileIds"] = [KB_FILE_ID]
        changed += 1
    return changed


def api(method, path, body=None, retries=5):
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(
            BASE + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
            headers={
                "Authorization": f"Bearer {KEY}",
                "Content-Type": "application/json",
                "User-Agent": "curl/8.5.0",
            },
        )
        try:
            with urllib.request.urlopen(req) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:300]
            last = f"{e.code}: {detail}"
            if e.code == 429:
                time.sleep(15 * (attempt + 1))
                continue
            if e.code < 500:
                raise RuntimeError(f"{method} {path} -> {last}")
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{method} {path} failed after {retries} tries -> {last}")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    only = args[0] if args else None
    for key, m in MANIFEST.items():
        if only and key != only:
            continue
        aid = m["assistant_id"]
        prompt = open(os.path.join(S, "fleet-prompts", os.path.basename(m["file"]))).read()
        time.sleep(1.2)
        a = api("GET", f"/assistant/{aid}")
        model = a["model"]

        # Inline tools are PRESERVED, never filtered.
        #
        # This block used to keep only `type == "query"` and the verify step
        # below then asserted that result -- so the script reported "applied"
        # at precisely the moment it had removed a capability. VAPI's own
        # end-call and transfer tools are inline entries, so every run stripped
        # anything of that shape from all twelve assistants, and the check
        # agreed with the script while only the server disagreed.
        #
        # Nothing inline is ours to delete. The manifest governs `toolIds`; it
        # says nothing about what VAPI or an operator attached inline.
        model["tools"] = list(model.get("tools") or [])
        repointed = repoint_knowledge_base(model)

        # toolIds are declarative from the manifest, but an id the manifest
        # does not name is KEPT rather than dropped: losing a binding silently
        # is the failure this script already caused once. Unmanaged ids are
        # reported on every run, and --prune-unmanaged is the explicit opt-in
        # for making the manifest exclusive.
        want_ids = [TOOL_IDS[t] for t in m["tools"]]
        known = set(TOOL_IDS.values())
        unmanaged = [i for i in (model.get("toolIds") or []) if i not in known]
        if unmanaged and not PRUNE_UNMANAGED:
            print(
                f"UNMANAGED     {m['name']:32s} keeping {len(unmanaged)} toolId(s) "
                f"the manifest does not name: {','.join(unmanaged)}",
                file=sys.stderr,
            )
        model["toolIds"] = want_ids + ([] if PRUNE_UNMANAGED else unmanaged)

        msgs = model.get("messages") or []
        sys_idx = next((i for i, x in enumerate(msgs) if x.get("role") == "system"), None)
        if sys_idx is None:
            print(f"SKIP {m['name']}: no system message", file=sys.stderr)
            continue
        msgs[sys_idx] = {**msgs[sys_idx], "content": prompt}
        model["messages"] = msgs

        api("PATCH", f"/assistant/{aid}", {"model": model})
        time.sleep(1.5)
        v = api("GET", f"/assistant/{aid}")
        vm = v["model"]
        got_ids = vm.get("toolIds") or []
        got_inline = [(t.get("type"), (t.get("function") or {}).get("name")) for t in vm.get("tools") or []]
        # Asserted by effect: read back which file the query tool is actually
        # bound to, rather than trusting that the PATCH carried it.
        got_kb_files = sorted(
            {
                f
                for t in vm.get("tools") or []
                if t.get("type") == "query"
                for kb in t.get("knowledgeBases") or []
                for f in kb.get("fileIds") or []
            }
            | set(((vm.get("knowledgeBase") or {}).get("fileIds")) or [])
        )
        got_sys = next(x for x in vm["messages"] if x["role"] == "system")["content"]
        # Assert what this script is responsible for, and nothing more. The old
        # check demanded the inline set be EXACTLY the KB tool, which made the
        # loss of the end-call tool a passing condition. Every manifest tool
        # must be bound; the KB query tool must have survived; anything else
        # inline is somebody else's and is not judged here.
        ok = (
            set(want_ids) <= set(got_ids)
            and any(kind == "query" for kind, _ in got_inline)
            and (not KB_FILE_ID or got_kb_files == [KB_FILE_ID])
            and len(got_sys) == len(prompt)
            and vm.get("model") == "gpt-5.6-luna"
        )
        status = "applied" if ok else "VERIFY-FAILED"
        kb_note = f" kb={','.join(got_kb_files) or 'none'}" + (f" (repointed {repointed})" if repointed else "")
        print(
            f"{status:14s} {m['name']:32s} prompt={len(got_sys)} toolIds={len(got_ids)} "
            f"inline={got_inline}{kb_note} model={vm.get('model')}"
        )


if __name__ == "__main__":
    main()
