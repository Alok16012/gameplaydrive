"use client";

import { useCallback, useEffect, useState } from "react";

// Bot opponents. With auto-generate on, every table draws fresh names from an effectively unlimited
// generator, mixed with any custom bots the Super Admin created in /admin → Bots.
// Demo build: the config lives in localStorage so /admin and the player app share it.

export interface BotProfile {
  id: string;
  name: string;
  emoji: string;
  bal: number;
  active: boolean;
  created: string;
}

export interface BotConfig {
  auto: boolean;
  custom: BotProfile[];
}

export interface Bot {
  name: string;
  emoji: string;
  bal: number;
}

const FIRST = [
  "Aarav", "Aditi", "Aditya", "Akash", "Aman", "Amit", "Ananya", "Anil", "Anjali", "Ankit", "Ansh", "Arjun", "Arnav", "Asha", "Ayaan", "Bhavna", "Chirag", "Deepak", "Deepika", "Dev",
  "Dhruv", "Divya", "Farhan", "Gaurav", "Harsh", "Isha", "Ishaan", "Jatin", "Jaya", "Kabir", "Kajal", "Karan", "Kavya", "Kiran", "Kunal", "Lakshmi", "Manish", "Meera", "Mohit", "Naina",
  "Neha", "Nikhil", "Nisha", "Pooja", "Pranav", "Priya", "Rahul", "Raj", "Rakesh", "Ravi", "Reena", "Rhea", "Riya", "Rohan", "Rohit", "Sahil", "Sakshi", "Sameer", "Sanjay", "Sara",
  "Shreya", "Shubham", "Simran", "Sneha", "Sonia", "Sumit", "Sunil", "Suresh", "Tanvi", "Tarun", "Uday", "Varun", "Vikas", "Vikram", "Vinay", "Vivek", "Yash", "Zoya", "Imran", "Salman",
  "Faizan", "Ayesha", "Gurpreet", "Harpreet", "Manpreet", "Jaspreet", "Arvind", "Bala", "Karthik", "Lokesh", "Murali", "Naveen", "Prakash", "Ramesh", "Senthil", "Vijay", "Anand", "Abhishek", "Pankaj", "Ritika",
];
const LAST = ["Sharma", "Verma", "Patel", "Singh", "Gupta", "Mehta", "Iyer", "Nair", "Reddy", "Rao", "Joshi", "Kapoor", "Khan", "Das", "Bose", "Jain", "Malhotra", "Chopra", "Yadav", "Pillai", "Shetty", "Kulkarni", "Desai", "Mishra", "Pandey"];
const TAGS = ["King", "Pro", "Ace", "Boss", "Star", "Raja", "Rani", "Champ", "Lucky", "Shark", "Tiger", "Ninja"];
export const BOT_AVATARS = ["👨🏽", "👩🏻", "🧔🏾", "👨🏻‍🦱", "👩🏽‍🦱", "🧑🏼", "👱🏽‍♂️", "👩🏾", "🧑🏽‍🦰", "👨🏿", "👩🏼‍🦰", "🧕🏽", "👳🏽‍♂️", "👨🏾‍🦲", "👵🏽", "🧑🏻‍🦱"];

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const shuffle = <T,>(a: T[]) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

/** A random screen name in one of the styles real players use. */
export function randomName(): string {
  const f = pick(FIRST);
  const n = Math.floor(Math.random() * 99) + 1;
  switch (Math.floor(Math.random() * 7)) {
    case 0: return f;
    case 1: return `${f} ${pick(LAST)[0]}`;
    case 2: return `${f.toLowerCase()}_${n}`;
    case 3: return `${f} ${pick(LAST)}`;
    case 4: return `${pick(TAGS)}${f}`;
    case 5: return `${f}${n}`;
    default: return `${f}_${pick(TAGS).toLowerCase()}`;
  }
}

export const randomBal = () => Math.round((300 + Math.random() * Math.random() * 24000) / 10) * 10;

const KEY = "gamehub.bots.v1";
const DEFAULT: BotConfig = { auto: true, custom: [] };

export function loadBotConfig(): BotConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT, ...(JSON.parse(raw) as BotConfig) };
  } catch {}
  return DEFAULT;
}

/** Bot config store for /admin. */
export function useBotConfig() {
  const [cfg, setCfg] = useState<BotConfig>(DEFAULT);
  useEffect(() => setCfg(loadBotConfig()), []);
  const update = useCallback((fn: (c: BotConfig) => BotConfig) => {
    setCfg((c) => {
      const next = fn(c);
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  return { cfg, update };
}

// Names seated recently, so back-to-back tables don't show the same faces.
const recent: string[] = [];
const remember = (name: string) => {
  recent.push(name);
  if (recent.length > 40) recent.shift();
};

/** Seat `n` distinct bots for a new table. `exclude` keeps names already at the table. */
export function pickBots(n: number, exclude: string[] = []): Bot[] {
  const cfg = loadBotConfig();
  const taken = new Set([...exclude, ...recent]);
  const custom = shuffle(cfg.custom.filter((b) => b.active && !taken.has(b.name)));
  // Auto on: custom bots take a random share of the seats, generated names fill the rest.
  // Auto off: only custom bots — generated names fill in only if there aren't enough of them.
  const fromCustom = Math.min(custom.length, cfg.auto ? Math.floor(Math.random() * (n + 1)) : n);
  const out: Bot[] = custom.slice(0, fromCustom).map((b) => ({ name: b.name, emoji: b.emoji, bal: b.bal }));
  const used = new Set([...taken, ...out.map((b) => b.name)]);
  let guard = 0;
  while (out.length < n) {
    const name = randomName();
    if (used.has(name) && guard++ < 200) continue;
    used.add(name);
    out.push({ name, emoji: pick(BOT_AVATARS), bal: randomBal() });
  }
  out.forEach((b) => remember(b.name));
  return shuffle(out);
}
