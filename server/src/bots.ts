// Bot opponents: active custom bots from the admin's Bots page, plus generated names (same style as the app).
import { getActiveBots, getSetting } from "./supa.js";

export interface BotInfo { name: string; emoji: string; bal: number; bot: true }
const FIRST = ["Aarav","Aditi","Aditya","Akash","Aman","Amit","Ananya","Anil","Anjali","Ankit","Arjun","Arnav","Asha","Bhavna","Chirag","Deepak","Deepika","Dev","Dhruv","Divya","Farhan","Gaurav","Harsh","Isha","Ishaan","Jatin","Kabir","Kajal","Karan","Kavya","Kiran","Kunal","Manish","Meera","Mohit","Naina","Neha","Nikhil","Nisha","Pooja","Pranav","Priya","Rahul","Raj","Rakesh","Ravi","Rhea","Riya","Rohan","Rohit","Sahil","Sakshi","Sameer","Sanjay","Shreya","Simran","Sneha","Sonia","Sumit","Suresh","Tanvi","Tarun","Varun","Vikas","Vikram","Vinay","Vivek","Yash","Zoya","Imran","Ayesha","Gurpreet","Karthik","Naveen","Prakash","Vijay","Anand","Abhishek","Ritika"];
const LAST = ["Sharma","Verma","Patel","Singh","Gupta","Mehta","Iyer","Nair","Reddy","Rao","Joshi","Kapoor","Khan","Das","Jain","Malhotra","Yadav","Shetty","Desai","Mishra"];
const TAGS = ["King","Pro","Ace","Boss","Star","Raja","Champ","Lucky","Shark","Tiger"];
const EMOJI = ["👨🏽","👩🏻","🧔🏾","👨🏻‍🦱","👩🏽‍🦱","🧑🏼","👱🏽‍♂️","👩🏾","🧑🏽‍🦰","👨🏿","👩🏼‍🦰","🧕🏽","👳🏽‍♂️","👨🏾‍🦲","🧑🏻‍🦱"];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

let custom: { name: string; emoji: string; bal: number }[] = [];
let auto = true;
export async function refreshBots() {
  try {
    custom = await getActiveBots();
    const a = await getSetting<boolean>("bots_auto");
    auto = a !== false;
  } catch (e) { console.warn("[bots] refresh failed", (e as Error).message); }
}

function generated(): string {
  const f = pick(FIRST), n = 1 + Math.floor(Math.random() * 99);
  switch (Math.floor(Math.random() * 6)) {
    case 0: return f;
    case 1: return `${f} ${pick(LAST)[0]}`;
    case 2: return `${f.toLowerCase()}_${n}`;
    case 3: return `${f} ${pick(LAST)}`;
    case 4: return `${pick(TAGS)}${f}`;
    default: return `${f}${n}`;
  }
}

export function makeBot(exclude: string[]): BotInfo {
  if ((!auto || Math.random() < 0.3) && custom.length) {
    const c = custom.filter((b) => !exclude.includes(b.name));
    if (c.length) { const b = pick(c); return { name: b.name, emoji: b.emoji, bal: Math.max(Number(b.bal), 500), bot: true }; }
  }
  let name = generated();
  for (let i = 0; i < 20 && exclude.includes(name); i++) name = generated();
  return { name, emoji: pick(EMOJI), bal: Math.floor((300 + Math.random() * Math.random() * 24000) / 10) * 10 + 500, bot: true };
}
