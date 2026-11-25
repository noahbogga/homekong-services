import json, time, urllib.request

URL = "http://192.168.50.209:8080/v1/chat/completions"

SYS = ("You are a deterministic odds compiler. For each input match, adjust prices "
       "numerically based on recent form and injuries, then output the adjusted book. "
       "Output JSON only.")

SCHEMA = {
  "type": "object",
  "properties": {
    "matches": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "home": {"type": "string"},
          "h2h": {"type": "array", "items": {"type": "object",
              "properties": {"name": {"type": "string"}, "price": {"type": "number"}},
              "required": ["name", "price"]}},
          "totals": {"type": "array", "items": {"type": "object",
              "properties": {"name": {"type": "string"}, "price": {"type": "number"}, "point": {"type": "number"}},
              "required": ["name", "price", "point"]}},
          "confidence": {"type": "number"},
          "adjustments": {"type": "array", "items": {"type": "string"}}
        },
        "required": ["home", "h2h", "totals", "confidence", "adjustments"]
      }
    }
  },
  "required": ["matches"]
}

M = [
 "M1: Arsenal v Chelsea EPL h2h 1.90/3.5/4.2 OU2.5 1.87/1.95 form WWWDW/LDWLL Chelsea striker out.",
 "M2: Bayern v Dortmund BL h2h 1.55/4.5/5.5 OU3.5 1.90/1.90 form WWWWW/WDLWW.",
 "M3: PSG v Lyon L1 h2h 1.40/5.0/7.0 OU2.5 1.75/2.05 form WWDWW/LLDWL PSG 2 defenders out.",
 "M4: Inter v Milan SA h2h 2.10/3.3/3.6 OU2.5 1.95/1.87 form WDWWL/WWDLW.",
 "M5: RealMadrid v Sevilla LL h2h 1.45/4.6/6.5 OU2.5 1.70/2.10 form WWWDW/LDLWL Sevilla GK out.",
]

def call(user, max_tokens):
    body = json.dumps({
        "messages": [{"role": "system", "content": SYS},
                     {"role": "user", "content": user}],
        "temperature": 0.1, "stream": False, "max_tokens": max_tokens,
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "odds", "schema": SCHEMA, "strict": True}},
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.loads(r.read())
    dt = time.time() - t0
    content = d["choices"][0]["message"]["content"]
    tim = d.get("timings", {})
    usage = d.get("usage", {})
    try:
        parsed = json.loads(content)
        ok = "VALID matches=%d" % len(parsed.get("matches", []))
    except Exception as e:
        ok = "INVALID(%s)" % e
    return dt, usage.get("completion_tokens","?"), tim.get("predicted_per_second"), ok, content

# warm
try:
    call(M[0], 300)
except Exception as e:
    print("warm err", e)

for name, cnt, mt in [("1-match",1,400),("3-match",3,1200),("5-match",5,2000)]:
    try:
        dt, ct, tps, ok, content = call("\n".join(M[:cnt]), mt)
        print("[%s] %.2fs (%.2fs/match) comp_tok=%s %.0f tok/s | %s" %
              (name, dt, dt/cnt, ct, tps or 0, ok))
        if name == "1-match":
            print("   SAMPLE:", content[:400])
    except Exception as e:
        print("[%s] ERROR %s" % (name, e))
