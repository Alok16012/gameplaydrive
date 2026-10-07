with open("app/api/sports/matches/route.ts", "r") as f:
    text = f.read()

# For the railway block
bad_block = """            if (b1 <= 0) {
              const base1 = Number((1.35 + ((evHash % 120) / 100)).toFixed(2));
              b1 = base1;
              l1 = Number((b1 + 0.03).toFixed(2));
              const p1 = 1 / b1;
              const p2 = Math.max(0.18, Math.min(0.82, 1.05 - p1));
              b2 = Number((1 / p2).toFixed(2));
              l2 = Number((b2 + 0.04).toFixed(2));
            }"""

text = text.replace(bad_block, "")
text = text.replace("const evHash = Math.abs([...evId].reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7));", "")

with open("app/api/sports/matches/route.ts", "w") as f:
    f.write(text)
