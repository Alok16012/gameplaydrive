with open("app/api/cricket/odds/route.ts", "r") as f:
    lines = f.readlines()

new_lines = []
skip = False

i = 0
while i < len(lines):
    line = lines[i]
    
    if "// Generate better Bookmaker odds based on matchOdds" in line:
        skip = True
    if skip and "const transformed = {" in line:
        skip = False
    
    if skip:
        i += 1
        continue
        
    if "bookMakerOdds: [" in line and not skip:
        # We need to change bookMakerOdds to empty array in the transformed object
        new_lines.append("          bookMakerOdds: [],\n")
        new_lines.append("          fancyOdds: [],\n")
        # skip until "};" after fancyOdds
        while "};" not in lines[i+1]:
            i += 1
        i += 1 # skip the "};" for the old object
        new_lines.append("        };\n")
        i += 1
        continue
        
    if "// 3. Generate match-specific realistic exchange odds" in line:
        # Here we end the file and return empty
        new_lines.append("  // If we reach here, both Railway Proxy and Direct DiamondExch API failed.\n")
        new_lines.append("  return NextResponse.json({\n")
        new_lines.append("    success: false,\n")
        new_lines.append("    message: \"No live odds available from Diamond API\",\n")
        new_lines.append("    data: {\n")
        new_lines.append("      matchOdds: [],\n")
        new_lines.append("      bookMakerOdds: [],\n")
        new_lines.append("      fancyOdds: [],\n")
        new_lines.append("    },\n")
        new_lines.append("  });\n")
        new_lines.append("}\n")
        break
        
    new_lines.append(line)
    i += 1

with open("app/api/cricket/odds/route.ts", "w") as f:
    f.writelines(new_lines)
