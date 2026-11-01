#!/usr/bin/env python3
"""Aplica/reverte o registro do MCP llm-router em configs de CLIs de agente.

Estado em $XDG_STATE_HOME/llm-router/install.json (ou ~/.local/state/...).
Só remove o que o instalador adicionou (registrado no manifesto).
"""
import argparse, json, os, re, shutil, subprocess, time
from pathlib import Path

NAME = "llm-router"
BEGIN, END = "# >>> llm-router (managed) >>>", "# <<< llm-router (managed) <<<"
HOME = Path(os.environ.get("HOME", "~")).expanduser()
STATE = Path(os.environ.get("XDG_STATE_HOME") or HOME / ".local/state") / NAME / "install.json"

# kind -> (arquivo relativo a HOME, chave do mapa)
JSON_KINDS = {
    "gemini": (".gemini/settings.json", "mcpServers"),
    "qwen": (".qwen/settings.json", "mcpServers"),
    "cursor-agent": (".cursor/mcp.json", "mcpServers"),
    "copilot": (".copilot/mcp-config.json", "mcpServers"),
    "opencode": (".config/opencode/opencode.json", "mcp"),
}
FILE_KINDS = {"codex": ".codex/config.toml", "goose": ".config/goose/config.yaml"}
ALL = ["claude", *FILE_KINDS, *JSON_KINDS]


def load_manifest():
    return json.loads(STATE.read_text()) if STATE.exists() else {"entries": {}}


def save_manifest(m):
    if m["entries"] or m.get("npm_ci"):
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(m, indent=2) + "\n")
    elif STATE.exists():
        STATE.unlink()
        try:
            STATE.parent.rmdir()
        except OSError:
            pass


def target(kind):
    if kind == "claude":
        return HOME / ".claude.json"
    return HOME / (FILE_KINDS.get(kind) or JSON_KINDS[kind][0])


def backup(path):
    if not path.exists():
        return None
    dst = path.with_name(f"{path.name}.llm-router.bak-{time.strftime('%Y%m%d%H%M%S')}")
    shutil.copy2(path, dst)
    return str(dst)


def entry(kind, cmd, args):
    if kind == "opencode":
        return {"type": "local", "command": [cmd, *args], "enabled": True}
    e = {"command": cmd, "args": args}
    if kind == "copilot":
        e.update(type="local", tools=["*"])
    return e


def block(kind, cmd, args):
    q = json.dumps
    if kind == "codex":
        body = f"[mcp_servers.{NAME}]\ncommand = {q(cmd)}\nargs = [{', '.join(q(a) for a in args)}]\n"
        return f"{BEGIN}\n{body}{END}\n"
    body = (f"  {NAME}:\n    type: stdio\n    name: {NAME}\n    enabled: true\n"
            f"    cmd: {q(cmd)}\n    args: [{', '.join(q(a) for a in args)}]\n    timeout: 300\n")
    return f"  {BEGIN}\n{body}  {END}\n"


def marker_re():
    return re.compile(rf"^[ \t]*{re.escape(BEGIN)}\n.*?^[ \t]*{re.escape(END)}\n", re.S | re.M)


def text_state(kind, text):
    if marker_re().search(text):
        return "ours"
    pat = rf"^\[mcp_servers\.{NAME}\]" if kind == "codex" else rf"^  {NAME}:"
    return "foreign" if re.search(pat, text, re.M) else None


def pre(dry):
    return "[dry-run] " if dry else ""


def record(m, kind, path, dry, bak, created):
    print(f"{pre(dry)}{kind}: registrar em {path}" + (f" (backup {bak})" if bak else ""))
    if not dry:
        m["entries"][kind] = {"file": str(path), "backup": bak, "created": created}
        save_manifest(m)


def apply(kind, cmd, args, dry):
    path = target(kind)
    m = load_manifest()

    if kind == "claude":
        got = subprocess.run(["claude", "mcp", "get", NAME], capture_output=True)
        if got.returncode == 0:
            print(f"{pre(dry)}{kind}: já registrado")
            return
        bak = None if dry else backup(path)
        if not dry:
            subprocess.run(["claude", "mcp", "add", "-s", "user", NAME, "--", cmd, *args], check=True)
        return record(m, kind, path, dry, bak, False)

    existed = path.exists()
    if kind in FILE_KINDS:
        text = path.read_text() if existed else ""
        st = text_state(kind, text)
        if st:
            print(f"{pre(dry)}{kind}: já registrado" + ("" if st == "ours" else " (entrada externa, intocada)"))
            return
        new = block(kind, cmd, args)
        sep = "" if (not text or text.endswith("\n")) else "\n"
        if kind == "goose":
            if re.search(r"^extensions:[ \t]*$", text, re.M):
                new_text = re.sub(r"^(extensions:[ \t]*\n)", lambda mo: mo.group(1) + new, text, count=1, flags=re.M)
            else:
                new_text = text + sep + "extensions:\n" + new
        else:
            new_text = text + sep + ("\n" if text else "") + new
        bak = None if dry else backup(path)
        if not dry:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(new_text)
        return record(m, kind, path, dry, bak, not existed)

    mapkey = JSON_KINDS[kind][1]
    data = json.loads(path.read_text() or "{}") if existed else {}
    servers = data.setdefault(mapkey, {})
    if NAME in servers:
        print(f"{pre(dry)}{kind}: já registrado")
        return
    servers[NAME] = entry(kind, cmd, args)
    bak = None if dry else backup(path)
    if not dry:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2) + "\n")
    return record(m, kind, path, dry, bak, not existed)


def revert(kind, dry):
    m = load_manifest()
    info = m["entries"].get(kind)
    if not info:
        print(f"{kind}: nada a desfazer")
        return
    path = Path(info["file"])
    print(f"{pre(dry)}{kind}: remover registro de {path}")
    if dry:
        return
    if kind == "claude":
        subprocess.run(["claude", "mcp", "remove", "-s", "user", NAME], check=False)
    elif path.exists():
        text = path.read_text()
        if kind in FILE_KINDS:
            text = marker_re().sub("", text)
            if kind == "goose":
                text = re.sub(r"^extensions:[ \t]*\n(?=\S|\Z)", "", text, flags=re.M)
            if info["created"] and not text.strip():
                path.unlink()
            else:
                path.write_text(text)
        else:
            data = json.loads(text or "{}")
            mk = JSON_KINDS[kind][1]
            data.get(mk, {}).pop(NAME, None)
            if mk in data and not data[mk]:
                del data[mk]
            if info["created"] and not data:
                path.unlink()
            else:
                path.write_text(json.dumps(data, indent=2) + "\n")
    del m["entries"][kind]
    save_manifest(m)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("op", choices=["apply", "revert", "kinds", "manifest-get", "manifest-set", "manifest-del"])
    p.add_argument("--kind")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--key")
    p.add_argument("--value")
    p.add_argument("cmd", nargs="*")
    a = p.parse_args()
    if a.op == "apply":
        apply(a.kind, a.cmd[0], a.cmd[1:], a.dry_run)
    elif a.op == "revert":
        revert(a.kind, a.dry_run)
    elif a.op == "kinds":
        print(" ".join(ALL))
    elif a.op == "manifest-get":
        v = load_manifest().get(a.key)
        print("" if v is None else json.dumps(v))
    elif a.op == "manifest-set":
        m = load_manifest()
        m[a.key] = json.loads(a.value)
        save_manifest(m)
    else:
        m = load_manifest()
        m.pop(a.key, None)
        save_manifest(m)


main()
