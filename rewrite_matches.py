with open("app/api/sports/matches/route.ts", "r") as f:
    lines = f.readlines()

new_lines = []
for line in lines:
    if "// Realistic fresh live & upcoming matches for today with live scores and real teams" in line:
        new_lines.append("  // If we reach here, both Railway Proxy and Direct DiamondExch API failed.\n")
        new_lines.append("  return NextResponse.json({\n")
        new_lines.append("    success: false,\n")
        new_lines.append("    message: \"No live matches available from Diamond API\",\n")
        new_lines.append("    data: [],\n")
        new_lines.append("    debug: railwayError || undefined,\n")
        new_lines.append("  });\n")
        new_lines.append("}\n")
        break
    new_lines.append(line)

with open("app/api/sports/matches/route.ts", "w") as f:
    f.writelines(new_lines)
