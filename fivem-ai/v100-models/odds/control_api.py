#!/usr/bin/env python3
"""
aether-odds-control : scoped management API for the odds LLM on .209.

Manages ONLY the odds model (llama-server on :8081) via config.json.
Cannot and does not touch aether-verifier, qdrant, or embedder.
Token-guarded (Bearer). Runs on :8091. Zero external deps (stdlib only).

Endpoints (all require Authorization: Bearer <token> except /health):
  GET  /health                 - liveness of this API (no auth)
  GET  /status                 - odds llama-server up? model? VRAM? slots?
  GET  /config                 - full current settings
  POST /config/params          - change default sampling (temp/top_p/seed/max_tokens/...)
  POST /config/prompt          - change system prompt (live via /props + persisted)
  POST /config/grammar         - replace the JSON schema constraining output
  GET  /models                 - list allowlisted models + which is loaded
  POST /model                  - swap to an allowlisted model (rewrites config + restart)
  POST /restart                - restart ONLY aether-odds
  POST /v1/chat/completions    - convenience proxy: injects prompt+schema+defaults -> :8081
"""
import json, os, subprocess, urllib.request, urllib.error, hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = "/home/dockeradmin/services/odds"
CONFIG_PATH = os.path.join(BASE, "config.json")
TOKEN_PATH = os.path.join(BASE, "token")
ODDS_SERVICE = "aether-odds"           # the ONLY systemd unit this API may touch
CONTROL_PORT = 8091

def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)

def save_config(cfg):
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, CONFIG_PATH)

def load_token():
    try:
        with open(TOKEN_PATH) as f:
            return f.read().strip()
    except FileNotFoundError:
        return None

def odds_base(cfg):
    return "http://127.0.0.1:%d" % cfg.get("port", 8081)

def read_text(path, default=""):
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        return default

def write_text(path, content):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(content)
    os.replace(tmp, path)

def http_json(method, url, payload=None, timeout=120):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        return r.status, body

def gpu_procs():
    """VRAM MiB per pid, from nvidia-smi. Empty dict on any failure."""
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-compute-apps=pid,used_memory",
             "--format=csv,noheader,nounits"], text=True, timeout=10)
    except Exception:
        return {}
    d = {}
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) == 2 and parts[0].isdigit():
            d[int(parts[0])] = int(parts[1]) if parts[1].isdigit() else 0
    return d

def restart_odds():
    """Restart ONLY the odds unit. Hardcoded name - never takes a unit argument."""
    return subprocess.run(["sudo", "systemctl", "restart", ODDS_SERVICE],
                          capture_output=True, text=True, timeout=120)

def odds_active():
    r = subprocess.run(["systemctl", "is-active", ODDS_SERVICE],
                       capture_output=True, text=True, timeout=10)
    return r.stdout.strip()

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print("[odds-control] " + (fmt % args))

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        token = load_token()
        if not token:
            self._send(500, {"error": "no server token configured"})
            return False
        hdr = self.headers.get("Authorization", "")
        given = hdr[7:] if hdr.startswith("Bearer ") else ""
        if not hmac.compare_digest(given, token):
            self._send(401, {"error": "unauthorized"})
            return False
        return True

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return None

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"status": "ok", "service": "aether-odds-control"})
        if not self._authed():
            return
        if self.path == "/status":
            return self.h_status()
        if self.path == "/config":
            return self.h_config()
        if self.path == "/models":
            return self.h_models()
        return self._send(404, {"error": "not found", "path": self.path})

    def do_POST(self):
        if not self._authed():
            return
        body = self._body()
        if body is None:
            return self._send(400, {"error": "invalid JSON body"})
        routes = {
            "/config/params": self.h_params,
            "/config/prompt": self.h_prompt,
            "/config/grammar": self.h_grammar,
            "/model": self.h_model,
            "/restart": self.h_restart,
            "/v1/chat/completions": self.h_proxy,
        }
        fn = routes.get(self.path)
        if not fn:
            return self._send(404, {"error": "not found", "path": self.path})
        try:
            return fn(body)
        except Exception as e:
            return self._send(500, {"error": str(e)})

    def h_status(self):
        cfg = load_config()
        active = odds_active()
        up, model, slots = False, None, None
        try:
            _, b = http_json("GET", odds_base(cfg) + "/v1/models", timeout=5)
            up = True
            model = json.loads(b).get("data", [{}])[0].get("id")
        except Exception:
            pass
        vram = None
        procs = gpu_procs()
        for pid, mib in procs.items():
            try:
                cmd = read_text("/proc/%d/cmdline" % pid).replace("\x00", " ")
                if "--port %d" % cfg.get("port", 8081) in cmd or cfg["model_path"] in cmd:
                    vram = mib
            except Exception:
                pass
        return self._send(200, {"service": ODDS_SERVICE, "systemd": active,
                                "http_up": up, "loaded_model": model,
                                "vram_mib": vram, "config_model": cfg.get("model_name")})

    def h_config(self):
        cfg = load_config()
        cfg = dict(cfg)
        cfg["system_prompt"] = read_text(cfg.get("system_prompt_file", ""), "")
        try:
            cfg["schema"] = json.loads(read_text(cfg.get("schema_file", ""), "{}"))
        except Exception:
            cfg["schema"] = None
        return self._send(200, cfg)

    def h_models(self):
        cfg = load_config()
        avail = {}
        for name, path in cfg.get("allowed_models", {}).items():
            avail[name] = {"path": path, "exists": os.path.exists(path),
                           "loaded": name == cfg.get("model_name")}
        return self._send(200, {"models": avail})

    def h_params(self, body):
        cfg = load_config()
        allowed = {"temperature", "top_p", "top_k", "min_p", "seed", "max_tokens", "repeat_penalty"}
        changed = {}
        for k, v in body.items():
            if k in allowed:
                cfg["defaults"][k] = v
                changed[k] = v
        if not changed:
            return self._send(400, {"error": "no valid params", "allowed": sorted(allowed)})
        save_config(cfg)
        return self._send(200, {"ok": True, "changed": changed,
                                "note": "applied to future requests via proxy; direct :8081 callers pass their own"})

    def h_prompt(self, body):
        cfg = load_config()
        prompt = body.get("system_prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            return self._send(400, {"error": "system_prompt (non-empty string) required"})
        write_text(cfg["system_prompt_file"], prompt)
        live = None
        if cfg.get("enable_props"):
            try:
                http_json("POST", odds_base(cfg) + "/props", {"system_prompt": prompt}, timeout=10)
                live = "applied live via /props"
            except Exception as e:
                live = "persisted; live update failed (%s); applies on next restart" % e
        else:
            live = "persisted; applies on next restart (--props disabled)"
        return self._send(200, {"ok": True, "persisted": True, "live": live})

    def h_grammar(self, body):
        cfg = load_config()
        schema = body.get("schema")
        if not isinstance(schema, dict):
            return self._send(400, {"error": "schema (JSON object) required"})
        write_text(cfg["schema_file"], json.dumps(schema, indent=2))
        return self._send(200, {"ok": True, "note": "schema saved; used by proxy immediately"})

    def h_model(self, body):
        cfg = load_config()
        name = body.get("model")
        allowed = cfg.get("allowed_models", {})
        if name not in allowed:
            return self._send(400, {"error": "model not allowlisted", "allowed": sorted(allowed)})
        if not os.path.exists(allowed[name]):
            return self._send(400, {"error": "model file missing on disk", "path": allowed[name]})
        cfg["model_name"] = name
        cfg["model_path"] = allowed[name]
        save_config(cfg)
        r = restart_odds()
        return self._send(200 if r.returncode == 0 else 500,
                          {"ok": r.returncode == 0, "model": name,
                           "restart_rc": r.returncode, "stderr": r.stderr[-300:]})

    def h_restart(self, body):
        r = restart_odds()
        return self._send(200 if r.returncode == 0 else 500,
                          {"ok": r.returncode == 0, "rc": r.returncode, "stderr": r.stderr[-300:]})

    def h_proxy(self, body):
        """Inject configured prompt + schema + default sampling, forward to :8081."""
        cfg = load_config()
        d = cfg["defaults"]
        msgs = body.get("messages")
        if not msgs:
            # convenience: accept {"input": "...match text..."} and build messages
            if "input" in body:
                msgs = [{"role": "user", "content": body["input"]}]
            else:
                return self._send(400, {"error": "messages[] or input required"})
        # prepend configured system prompt unless caller already sent one
        if not any(m.get("role") == "system" for m in msgs):
            msgs = [{"role": "system", "content": read_text(cfg["system_prompt_file"])}] + msgs
        try:
            schema = json.loads(read_text(cfg["schema_file"], "{}"))
        except Exception:
            schema = None
        payload = {
            "messages": msgs,
            "temperature": body.get("temperature", d["temperature"]),
            "top_p": body.get("top_p", d["top_p"]),
            "seed": body.get("seed", d["seed"]),
            "max_tokens": body.get("max_tokens", d["max_tokens"]),
            "stream": False,
        }
        if schema:
            payload["response_format"] = {"type": "json_schema",
                                          "json_schema": {"name": "odds", "schema": schema, "strict": True}}
        try:
            status, b = http_json("POST", odds_base(cfg) + "/v1/chat/completions", payload, timeout=180)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
        except urllib.error.HTTPError as e:
            eb = e.read()
            self._send(e.code, {"error": "upstream", "detail": eb.decode(errors="replace")[:400]})
        except Exception as e:
            self._send(502, {"error": "odds server unreachable", "detail": str(e)})


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", CONTROL_PORT), Handler)
    print("[odds-control] listening on :%d, managing '%s' only" % (CONTROL_PORT, ODDS_SERVICE))
    srv.serve_forever()

if __name__ == "__main__":
    main()
