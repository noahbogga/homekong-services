import json, time, urllib.request

SYS = ("You are a deterministic odds compiler. Input is one or more matches. "
       "For each match, adjust prices numerically based on form and injuries. "
       'Return ONLY a JSON object: {"matches":[{"home":str,"h2h":[{"name":str,"price":num}],'
       '"totals":[{"name":str,"price":num,"point":num}],"confidence":num,"adjustments":[str]}]}. '
       "Keep adjustments to <=3 short snake_case tags. No prose outside JSON.")

M = [
 "M1: Arsenal v Chelsea EPL h2h 1.90/3.5/4.2 OU2.5 1.87/1.95 form WWWDW/LDWLL Chelsea striker out.",
 "M2: Bayern v Dortmund BL h2h 1.55/4.5/5.5 OU3.5 1.90/1.90 form WWWWW/WDLWW.",
 "M3: PSG v Lyon L1 h2h 1.40/5.0/7.0 OU2.5 1.75/2.05 form WWDWW/LLDWL PSG 2 defenders out.",
 "M4: Inter v Milan SA h2h 2.10/3.3/3.6 OU2.5 1.95/1.87 form WDWWL/WWDLW.",
 "M5: RealMadrid v Sevilla LL h2h 1.45/4.6/6.5 OU2.5 1.70/2.10 form WWWDW/LDLWL Sevilla GK out.",
 "M6: Liverpool v Spurs EPL h2h 1.75/3.9/4.6 OU3.5 2.00/1.80 form WWDWW/DLWWL.",
 "M7: Juventus v Napoli SA h2h 2.40/3.1/3.1 OU2.5 2.05/1.78 form DWWDL/WWWDW.",
 "M8: Atletico v Barca LL h2h 3.0/3.3/2.4 OU2.5 1.85/1.95 form WDWWW/WWDWW Atletico winger out.",
]

def call(url, model, user, max_tokens, extra=""):
    u = user + ("\n"+extra if extra else "")
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": SYS},
                     {"role": "user", "content": u}],
        "temperature": 0.1, "stream": False, "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read())
    dt = time.time() - t0
    content = d["choices"][0]["message"]["content"]
    usage = d.get("usage", {})
    try:
        parsed = json.loads(content)
        n = len(parsed.get("matches", parsed if isinstance(parsed, list) else [parsed]))
        ok = "VALID matches=%d" % n
    except Exception as e:
        ok = "INVALID(%s) head=%r" % (e, content[:80])
    return dt, usage, ok

OLL = "http://192.168.50.208:11434/v1/chat/completions"
NOTHINK = "/no_think"  # qwen3 switch

def bench(label, url, model, extra=""):
    # warm
    try:
        call(url, model, M[0], 300, extra)
    except Exception as e:
        print("[%s] WARM ERROR %s" % (label, e)); return
    for name, cnt, mt in [("1m",1,400),("5m",5,2000),("10m",10,3600)]:
        try:
            dt, usage, ok = call(url, model, "\n".join(M[:cnt] if cnt<=8 else M+M[:cnt-8]), mt, extra)
            print("[%s %s] %.2fs (%.2fs/match) comp_tok=%s | %s" %
                  (label, name, dt, dt/cnt, usage.get("completion_tokens","?"), ok))
        except Exception as e:
            print("[%s %s] ERROR %s" % (label, name, e))

bench("phi4-mini", OLL, "phi4-mini:latest")
bench("qwen3:14b", OLL, "qwen3:14b", NOTHINK)
bench("llama3.1-8b-abl", OLL, "mannix/llama3.1-8b-abliterated:latest")
