// THE METRIC — fixed, code-graded, never edited by the agent.
//
// Prints `score: <accuracy %>` as its last line. Higher is better. Deliberately
// small so an iteration costs seconds; swap in your own data and it is still
// the same loop.
import { isSpam } from "./heuristic.mjs";

const DATA = [
  ["Congratulations! You have been selected for a FREE cruise. Call now!!!", true],
  ["URGENT: your account will be suspended, verify your password at http://bit.ly/x", true],
  ["Make $$$ from home — no experience needed, limited spots", true],
  ["Win a brand new iPhone 15 — click here to claim your prize", true],
  ["Hot singles in your area are waiting for you", true],
  ["Your package could not be delivered. Confirm your address: http://tinyurl.com/q", true],
  ["Earn 500% returns with this crypto signal group, guaranteed", true],
  ["Dear customer, you have (1) unclaimed reward pending", true],
  ["Lose 30 pounds in 30 days with this one weird trick", true],
  ["FINAL NOTICE: act now or lose access forever!!!", true],
  ["Cheap meds online, no prescription required", true],
  ["You've won! Reply YES to receive your $1000 gift card", true],
  ["Hey, are we still on for lunch tomorrow at noon?", false],
  ["The quarterly report is attached — let me know if the numbers look off.", false],
  ["Reminder: dentist appointment Thursday at 3pm.", false],
  ["Can you send me the recipe for that lentil soup?", false],
  ["Free parking is available behind the building after 6pm.", false],
  ["The meeting moved to room 4B. Same time.", false],
  ["Thanks for the birthday wishes everyone!", false],
  ["I pushed the fix to main, CI is green now.", false],
  ["Your invoice #4821 for $340 is due on the 15th — thanks, Maria", false],
  ["Grandma says hi and wants to know when you're visiting.", false],
  ["The library book is due back next week.", false],
  ["Running 10 minutes late, order me a coffee?", false],
];

let correct = 0;
for (const [text, label] of DATA) if (Boolean(isSpam(text)) === label) correct++;
const score = Math.round((correct / DATA.length) * 1000) / 10;
console.log(`${correct}/${DATA.length} correct`);
console.log(`score: ${score}`);
