import json, time, urllib.request
URL = "http://192.168.50.209:8081/v1/chat/completions"
SYS = (
 "You are a football odds analyst. For each input match you are given the current "
 "sportsbook odds plus recent form and injury notes. Your job is NOT to compute final "
 "prices. Output how TRUE probabilities should shift vs the current market.\n"
 "home_shift/draw_shift/away_shift = probability mass to move (-0.15..0.15, ~sum 0). "
 "Positive home_shift = home MORE likely to win than market implies. "
 "totals_shift positive = lean Over. confidence 0..1. adjustments <=3 snake_case tags. "
 "Only use the evidence given; no evidence => 0 shift."
)
SCHEMA = {"type":"object","properties":{"matches":{"type":"array","items":{"type":"object","properties":{
  "home":{"type":"string"},"home_shift":{"type":"number"},"draw_shift":{"type":"number"},
  "away_shift":{"type":"number"},"totals_shift":{"type":"number"},"confidence":{"type":"number"},
  "adjustments":{"type":"array","items":{"type":"string"},"maxItems":3}},
  "required":["home","home_shift","draw_shift","away_shift","totals_shift","confidence","adjustments"]}}},"required":["matches"]}

ARS = "M1: Arsenal(home) v Chelsea EPL. Market h2h 1.90/3.5/4.2, OU2.5 1.87/1.95. Form Arsenal WWWDW, Chelsea LDWLL. Chelsea first-choice striker OUT injured."

def call(user, seed=None):
    payload = {"messages":[{"role":"system","content":SYS},{"role":"user","content":user}],
        "temperature":0.1,"top_p":0.9,"stream":False,"max_tokens":300,
        "response_format":{"type":"json_schema","json_schema":{"name":"odds","schema":SCHEMA,"strict":True}}}
    if seed is not None: payload["seed"]=seed
    body=json.dumps(payload).encode()
    req=urllib.request.Request(URL,data=body,headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req,timeout=60) as r: d=json.loads(r.read())
    return json.loads(d["choices"][0]["message"]["content"])["matches"][0]

print("=== SINGLE-MATCH Arsenal, temp 0.1, no seed, 5 runs (expect home_shift POSITIVE, stable) ===")
for i in range(5):
    m=call(ARS)
    print("  run%d: home_shift=%+.3f away_shift=%+.3f tot=%+.3f conf=%.2f adj=%s"%(
        i,m["home_shift"],m["away_shift"],m["totals_shift"],m["confidence"],m["adjustments"]))

print("=== SINGLE-MATCH Arsenal, fixed seed=42, 3 runs (expect IDENTICAL) ===")
for i in range(3):
    m=call(ARS,seed=42)
    print("  run%d: home_shift=%+.3f away_shift=%+.3f tot=%+.3f"%(i,m["home_shift"],m["away_shift"],m["totals_shift"]))

# a clean control: strong home favorite, home injury -> home_shift should go NEGATIVE
CTRL = "M1: RealMadrid(home) v Sevilla LL. Market h2h 1.45/4.6/6.5, OU2.5 1.70/2.10. Form RM LLDLL (poor), Sevilla WWWWW (excellent). RealMadrid star striker AND top defender OUT."
print("=== CONTROL: RM home but poor form + 2 injuries vs hot Sevilla (expect home_shift NEGATIVE) ===")
for i in range(3):
    m=call(CTRL)
    print("  run%d: home_shift=%+.3f away_shift=%+.3f conf=%.2f adj=%s"%(i,m["home_shift"],m["away_shift"],m["confidence"],m["adjustments"]))

# no-evidence control: shifts should be ~0
NOEV = "M1: TeamA(home) v TeamB EPL. Market h2h 2.00/3.4/3.8, OU2.5 1.90/1.90. No form data. No injuries."
print("=== CONTROL: no evidence (expect all shifts ~0) ===")
for i in range(3):
    m=call(NOEV)
    print("  run%d: home_shift=%+.3f draw=%+.3f away_shift=%+.3f tot=%+.3f"%(i,m["home_shift"],m["draw_shift"],m["away_shift"],m["totals_shift"]))
