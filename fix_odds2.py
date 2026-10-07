with open("app/api/cricket/odds/route.ts", "r") as f:
    text = f.read()

replacement = """        // Sanitize Match Odds (convert 1000 to "-")
        const sanitizedMatchOdds = oddDatas.map((r: any) => ({
          ...r,
          b1: (r.b1 === "1000" || r.b1 === "1000.00" || r.b1 === "1000.0") ? "-" : r.b1,
          l1: (r.l1 === "1000" || r.l1 === "1000.00" || r.l1 === "1000.0") ? "-" : r.l1,
          b2: (r.b2 === "1000" || r.b2 === "1000.00" || r.b2 === "1000.0") ? "-" : r.b2,
          l2: (r.l2 === "1000" || r.l2 === "1000.00" || r.l2 === "1000.0") ? "-" : r.l2,
          b3: (r.b3 === "1000" || r.b3 === "1000.00" || r.b3 === "1000.0") ? "-" : r.b3,
          l3: (r.l3 === "1000" || r.l3 === "1000.00" || r.l3 === "1000.0") ? "-" : r.l3,
          status: (r.b1 === "1000" || r.b1 === "1000.00" || r.b1 === "1000.0" || r.status === "SUSPENDED") ? "SUSPENDED" : r.status,
        }));
        const transformed = {"""

text = text.replace("const transformed = {", replacement)
text = text.replace("oddDatas: oddDatas,", "oddDatas: sanitizedMatchOdds,")

with open("app/api/cricket/odds/route.ts", "w") as f:
    f.write(text)
