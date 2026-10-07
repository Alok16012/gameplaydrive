with open("app/api/sports/matches/route.ts", "r") as f:
    lines = f.readlines()

new_lines = []
skip = False
for line in lines:
    if "// 1.5 Direct my99exch Highlight Odds Ingestion" in line:
        skip = True
    if skip and "// 2. Attempt direct DiamondExch API call" in line:
        skip = False
    if not skip:
        new_lines.append(line)

with open("app/api/sports/matches/route.ts", "w") as f:
    f.writelines(new_lines)


with open("app/api/cricket/odds/route.ts", "r") as f:
    lines = f.readlines()

new_lines2 = []
skip2 = False
for line in lines:
    if "// 2.5 Direct my99exch Highlight Odds Ingestion" in line:
        skip2 = True
    if skip2 and "// If we reach here, both Railway Proxy and Direct DiamondExch API failed." in line:
        skip2 = False
    if not skip2:
        new_lines2.append(line)

with open("app/api/cricket/odds/route.ts", "w") as f:
    f.writelines(new_lines2)

