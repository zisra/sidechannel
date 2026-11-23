// Random but stable display names, like "curious otter", derived from a
// member's id so everyone in the channel sees the same name for them.

const ADJECTIVES = [
  "quiet", "curious", "sleepy", "brave", "clever", "gentle", "lucky", "nimble",
  "mellow", "witty", "sunny", "cosmic", "fuzzy", "silent", "swift", "bold",
  "calm", "eager", "fancy", "jolly", "keen", "lively", "merry", "noble",
  "plucky", "proud", "rapid", "shy", "snappy", "spry", "tidy", "vivid",
  "wild", "zany", "amber", "crimson", "golden", "misty", "frosty", "dusty",
  "electric", "neon", "pixel", "binary", "atomic", "lunar", "solar", "velvet",
];

const ANIMALS = [
  "otter", "fox", "owl", "lynx", "panda", "koala", "heron", "badger",
  "beaver", "falcon", "gecko", "ibis", "jackal", "lemur", "marten", "newt",
  "ocelot", "puffin", "quokka", "raven", "seal", "tapir", "urchin", "viper",
  "walrus", "yak", "zebra", "bison", "crane", "dingo", "egret", "ferret",
  "gopher", "hare", "iguana", "kiwi", "llama", "moose", "narwhal", "orca",
  "pelican", "robin", "sloth", "toucan", "wombat", "axolotl", "capybara", "octopus",
];

// Distinct on light and dark backgrounds, and none of them the accent.
const COLORS = ["#3b82f6", "#10b981", "#a855f7", "#ec4899", "#eab308", "#06b6d4", "#ef4444", "#84cc16", "#6366f1", "#14b8a6"];

export type Person = { id: string; name: string; initials: string; color: string };

export function people(members: { id: string; n: number }[]): Map<string, Person> {
  const out = new Map<string, Person>();
  const taken = new Map<string, number>();
  for (const m of [...members].sort((a, b) => a.n - b.n)) {
    const hash = fnv1a(m.id);
    const adjective = ADJECTIVES[hash % ADJECTIVES.length];
    const animal = ANIMALS[Math.floor(hash / ADJECTIVES.length) % ANIMALS.length];
    let name = `${adjective} ${animal}`;
    // Two people with the same name would be confusing; number the repeat.
    const seen = taken.get(name) ?? 0;
    taken.set(name, seen + 1);
    if (seen) name += ` ${seen + 1}`;
    out.set(m.id, {
      id: m.id,
      name,
      initials: (adjective[0] + animal[0]).toUpperCase(),
      color: COLORS[(m.n - 1) % COLORS.length],
    });
  }
  return out;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
