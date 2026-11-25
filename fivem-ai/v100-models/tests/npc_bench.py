#!/usr/bin/env python3
"""npc_bench.py — load harness for the HK NPC-AI dialog endpoint.

Stdlib only. Hits an OpenAI-compatible /v1/chat/completions endpoint with a
padded NPC-dealer prompt (system + 2 few-shot + rotating live line), asks for a
JSON object, ramps concurrency, and reports latency percentiles, tok/s, JSON
validity, errors, and sampled nvidia-smi util/mem per level.

Usage:
  python3 npc_bench.py --url http://127.0.0.1:8092/v1/chat/completions \
      [--levels 1,4,8,16,30] [--per-level 20] [--max-tokens 90]
"""
import argparse, json, time, threading, subprocess, statistics, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

SYSTEM = (
    "You are a shady street-level drug dealer NPC in a GTA-style game world. "
    "Stay fully in character: streetwise, wary, greedy, sometimes hostile. "
    "You ALWAYS reply with ONE JSON object and nothing else, matching this schema:\n"
    '{"dialog": "<one spoken line, <=22 words>", '
    '"action": "greet|deal|refuse|haggle|flee|threaten", '
    '"price_mult": 0.7, '
    '"mood": "calm|nervous|hostile|greedy|friendly"}\n'
    "dialog is the only free text. Everything else is an enum or float."
)

# Two few-shot examples to lock the format (this also mimics real prompt padding).
FEWSHOT = [
    {"role": "user", "content": "PLAYER[rep=low, cash=$40, wanted=0] says: yo you holding?"},
    {"role": "assistant", "content": '{"dialog": "Maybe. You a cop? Forty gets you a taste, nothin more.", "action": "deal", "price_mult": 1.0, "mood": "wary"}'.replace('"wary"', '"nervous"')},
    {"role": "user", "content": "PLAYER[rep=high, cash=$500, wanted=2] says: gimme the usual, and hurry"},
    {"role": "assistant", "content": '{"dialog": "For you, discount. But you\'re hot right now, make it quick.", "action": "deal", "price_mult": 0.8, "mood": "greedy"}'},
]

# Rotating live player lines so the server can't trivially cache one string.
LIVE_LINES = [
    "PLAYER[rep=none, cash=$120, wanted=0] says: what you got for a buck twenty?",
    "PLAYER[rep=low, cash=$10, wanted=1] says: front me a bag, I'm good for it",
    "PLAYER[rep=mid, cash=$300, wanted=0] says: you seen the guy from uptown?",
    "PLAYER[rep=high, cash=$0, wanted=4] says: cops are on me, hide me quick!",
    "PLAYER[rep=none, cash=$60, wanted=0] says: this stuff better be real this time",
]

REQUIRED_KEYS = {"dialog", "action", "price_mult", "mood"}
USE_GRAMMAR = True


# GBNF grammar forcing the exact NPC schema. llama.cpp constrains sampling to
# this, so JSON validity becomes ~100% regardless of the model's tokenizer.
NPC_GRAMMAR = r'''
root   ::= "{" ws "\"dialog\"" ws ":" ws string ws "," ws "\"action\"" ws ":" ws action ws "," ws "\"price_mult\"" ws ":" ws number ws "," ws "\"mood\"" ws ":" ws mood ws "}"
action ::= "\"greet\"" | "\"deal\"" | "\"refuse\"" | "\"haggle\"" | "\"flee\"" | "\"threaten\""
mood   ::= "\"calm\"" | "\"nervous\"" | "\"hostile\"" | "\"greedy\"" | "\"friendly\""
string ::= "\"" ([^"\\] | "\\" ["\\/bfnrt])* "\""
number ::= "0" "." [0-9] [0-9]? | "1" ("." "0" [0-9]?)?
ws     ::= [ \t\n]*
'''


def build_body(i, max_tokens, use_grammar=True):
    live = LIVE_LINES[i % len(LIVE_LINES)]
    messages = [{"role": "system", "content": SYSTEM}] + FEWSHOT + [
        {"role": "user", "content": live}
    ]
    body = {
        "model": "local",
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.8,
    }
    if use_grammar:
        body["grammar"] = NPC_GRAMMAR      # llama.cpp native grammar constraint
    else:
        body["response_format"] = {"type": "json_object"}
    return body


def one_call(url, i, max_tokens, use_grammar=True):
    body = json.dumps(build_body(i, max_tokens, use_grammar)).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode())
        dt = time.time() - t0
        content = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {})
        ctok = usage.get("completion_tokens") or 0
        # JSON validity: parses AND has all 4 keys
        jok = False
        try:
            obj = json.loads(content)
            jok = REQUIRED_KEYS.issubset(obj.keys())
        except Exception:
            jok = False
        return {"ok": True, "dt": dt, "ctok": ctok, "jok": jok, "tok_s": (ctok / dt if dt > 0 else 0)}
    except Exception as e:
        return {"ok": False, "dt": time.time() - t0, "ctok": 0, "jok": False, "err": str(e)[:80]}


class SmiSampler(threading.Thread):
    """Samples nvidia-smi util% and mem-used(MiB) every 0.5s until stopped."""
    def __init__(self):
        super().__init__(daemon=True)
        self.samples = []
        self._stop = threading.Event()

    def run(self):
        while not self._stop.is_set():
            try:
                out = subprocess.check_output(
                    ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.free",
                     "--format=csv,noheader,nounits"], timeout=3).decode().strip().splitlines()[0]
                util, used, free = [int(x.strip()) for x in out.split(",")]
                self.samples.append((util, used, free))
            except Exception:
                pass
            self._stop.wait(0.5)

    def stop(self):
        self._stop.set()

    def summary(self):
        if not self.samples:
            return "smi: n/a"
        u = [s[0] for s in self.samples]; m = [s[1] for s in self.samples]; f = [s[2] for s in self.samples]
        return (f"util avg/max={statistics.mean(u):.0f}/{max(u)}%  "
                f"mem used avg/max={statistics.mean(m):.0f}/{max(m)}MiB  "
                f"free min={min(f)}MiB")


def pct(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    k = (len(s) - 1) * (p / 100.0)
    lo = int(k); hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def run_level(url, conc, n, max_tokens):
    smi = SmiSampler(); smi.start()
    results = []
    wall0 = time.time()
    with ThreadPoolExecutor(max_workers=conc) as ex:
        futs = [ex.submit(one_call, url, i, max_tokens, USE_GRAMMAR) for i in range(n)]
        for fu in as_completed(futs):
            results.append(fu.result())
    wall = time.time() - wall0
    smi.stop(); time.sleep(0.05)

    ok = [r for r in results if r["ok"]]
    lat = [r["dt"] for r in ok]
    jok = sum(1 for r in ok if r["jok"])
    ctok = sum(r["ctok"] for r in ok)
    errs = [r.get("err", "") for r in results if not r["ok"]]

    print(f"\n### concurrency={conc}  reqs={n}")
    print(f"  ok={len(ok)}/{n}  errors={len(results)-len(ok)}")
    if lat:
        print(f"  latency  p50={pct(lat,50):.2f}s  p95={pct(lat,95):.2f}s  p99={pct(lat,99):.2f}s  max={max(lat):.2f}s")
        print(f"  json-valid={jok}/{len(ok)} ({100*jok/len(ok):.0f}%)")
        print(f"  tok/s per-call avg={statistics.mean([r['tok_s'] for r in ok]):.1f}  aggregate={ctok/wall:.1f}  (wall={wall:.1f}s)")
    print(f"  {smi.summary()}")
    if errs:
        from collections import Counter
        for e, c in Counter(errs).most_common(3):
            print(f"  ERR x{c}: {e}")
    return {"conc": conc, "p95": pct(lat, 95) if lat else None, "json_pct": (100*jok/len(ok) if ok else 0),
            "ok": len(ok), "n": n}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8092/v1/chat/completions")
    ap.add_argument("--levels", default="1,4,8,16,30")
    ap.add_argument("--per-level", type=int, default=20)
    ap.add_argument("--max-tokens", type=int, default=90)
    ap.add_argument("--no-grammar", action="store_true", help="use json_object instead of GBNF grammar")
    args = ap.parse_args()
    levels = [int(x) for x in args.levels.split(",")]
    global USE_GRAMMAR
    USE_GRAMMAR = not args.no_grammar
    print(f"grammar-constrained: {USE_GRAMMAR}")

    print(f"=== NPC bench @ {args.url} ===")
    print(f"levels={levels}  per-level={args.per_level}  max_tokens={args.max_tokens}")
    print("warming up (1 call)...")
    print("  warmup:", one_call(args.url, 0, args.max_tokens, USE_GRAMMAR))

    summary = []
    for conc in levels:
        summary.append(run_level(args.url, conc, args.per_level, args.max_tokens))

    print("\n========== SUMMARY ==========")
    print(f"{'conc':>5} {'ok':>7} {'p95(s)':>8} {'json%':>7}")
    for s in summary:
        p95 = f"{s['p95']:.2f}" if s['p95'] is not None else "n/a"
        print(f"{s['conc']:>5} {s['ok']:>3}/{s['n']:<3} {p95:>8} {s['json_pct']:>6.0f}%")
    # verdict on the discriminator
    burst = next((s for s in summary if s["conc"] == 30), summary[-1])
    print("\n--- DISCRIMINATOR (30-burst) ---")
    if burst["p95"] is not None:
        verdict = "PASS" if (burst["p95"] < 5.0 and burst["json_pct"] >= 90) else "FAIL"
        print(f"  p95={burst['p95']:.2f}s (target <5s)  json%={burst['json_pct']:.0f} (target >=90)  => {verdict}")


if __name__ == "__main__":
    main()
