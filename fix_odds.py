with open("app/api/cricket/odds/route.ts", "r") as f:
    text = f.read()

text = text.replace("oddDatas: sanitizedMatchOdds,", "oddDatas: oddDatas,")

with open("app/api/cricket/odds/route.ts", "w") as f:
    f.write(text)
