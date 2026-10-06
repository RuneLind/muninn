/**
 * Ten SYNTHESIZED talks for `scripts/eval-transcript-check.ts` — no live-corpus
 * document, since this repo is public. Each carries claims as the web check
 * would save them (index, title, quote) and the transcript verdict a careful
 * reader gives each one. Every fixture holds at least one known mismatch, in
 * the classes the takeaway check named on real captures: an added cause, a
 * changed number, a hedge turned certain, a view the speaker rejected, and a
 * claim with no source at all. Fixture 10 is longer than the 60,000-character
 * cap, with one claim supported only past the cut.
 */

import type { TranscriptCheckInputClaim, TranscriptVerdict } from "../transcript-check.ts";

export interface TranscriptFixture {
  id: string;
  transcript: string;
  claims: Array<TranscriptCheckInputClaim & { expected: TranscriptVerdict; webVerdict?: string }>;
}

const sleep = `### [00:00:00]

Thanks for having me. I study sleep in shift workers, and tonight I want to talk about caffeine, because it is the drug almost everyone in this room took today.

### [00:01:10]

Caffeine's half-life in a healthy adult is roughly five to six hours. That means if you have a coffee at four in the afternoon, a good part of it is still in your system at ten at night. People are surprised by that.

### [00:03:40]

In our lab study of forty-two nurses, the ones who stopped caffeine after noon fell asleep on average eighteen minutes faster. Eighteen minutes. That is a small study, and I would not build policy on it, but it matches what others have found.

### [00:06:05]

What I do not believe is the popular claim that decaf is completely caffeine free. It is not; a cup of decaf still carries a few milligrams. For most people that does not matter.`;

const climate = `### [00:00:00]

Good morning. I am going to talk about heat pumps in cold climates, which is my whole career.

### [00:02:00]

The old story was that heat pumps stop working below freezing. That was true of the units from the nineties. Modern cold-climate units keep a coefficient of performance above two down to minus fifteen degrees Celsius. Below about minus twenty-five, most of them need a backup heater.

### [00:04:30]

In Norway, about six in ten detached homes now have a heat pump of some kind. The main driver was electricity prices, not subsidies — the subsidies were small and came late.

### [00:07:15]

I get asked whether ground-source is always better than air-source. My honest answer: it depends on the site. Ground-source has better efficiency, but drilling costs can wipe out the savings for twenty years.`;

const startups = `### [00:00:00]

I have started three companies. Two failed. I want to talk about the second one, because that failure taught me the most.

### [00:01:30]

We raised a seed round of one point two million dollars. We spent eighteen months building a product nobody asked for. Our mistake was not talking to customers — I am not going to blame the market, the market was fine.

### [00:04:00]

Some people say you should never take venture money. I think that is wrong. Venture money is a tool; it was not the money that killed us, it was what we did with it.

### [00:06:20]

The third company we bootstrapped. It is profitable, it has twelve employees, and we have no plans to raise.`;

const rust = `### [00:00:00]

Hi everyone. This talk is about migrating a payments service from Go to Rust.

### [00:02:10]

We did it for one reason: tail latency. Our p99 was around forty milliseconds in Go, mostly garbage-collector pauses. After the migration the p99 dropped to about twelve milliseconds.

### [00:05:00]

The migration took two engineers about nine months. I want to be honest: it was harder than we expected, mostly the async ecosystem, not the borrow checker. The borrow checker took people maybe two weeks to get comfortable with.

### [00:08:30]

Would I recommend everyone rewrite in Rust? No. If your latency budget is fine, a rewrite is a cost with no payoff.`;

const nutrition = `### [00:00:00]

Welcome back to the podcast. Today my guest is a dietitian who works with endurance athletes.

### [00:01:45]

GUEST: The most common mistake I see is under-fuelling. Athletes training more than ten hours a week often eat several hundred calories a day too few, and their performance plateaus.

### [00:04:10]

GUEST: Protein matters, but people overdo the timing obsession. Something like one point six grams per kilo of body weight per day covers most athletes. Whether you eat it within thirty minutes of training matters much less than the total.

### [00:07:00]

HOST: What about supplements? GUEST: Creatine has good evidence for strength work. For endurance, the evidence is weaker. I would not tell a marathoner it is essential.`;

const history = `### [00:00:00]

Tonight's lecture is about the printing press and the Reformation.

### [00:02:30]

Gutenberg's press was working in Mainz by around 1450. The famous Bible was finished around 1455. Within fifty years there were presses in more than two hundred European cities.

### [00:05:15]

It is tempting to say the press caused the Reformation. I do not think that holds. Luther's pamphlets spread fast because of the press, yes, but the grievances were decades old. The press was an accelerant, not the cause.

### [00:08:40]

Luther's ninety-five theses were written in Latin, for scholars. It was the German translations, printed within weeks, that reached ordinary readers.`;

const security = `### [00:00:00]

I run incident response for a mid-sized bank. Let me tell you about last year's phishing campaign.

### [00:01:50]

The attackers sent about three thousand emails over two days. Around four percent of recipients clicked the link. Of those, eleven people entered their credentials.

### [00:04:20]

What stopped it was hardware security keys. Every one of the eleven had a key enrolled, so the stolen passwords were useless. We had rolled the keys out six months earlier, against a lot of internal resistance.

### [00:07:05]

I do not think user training alone works. We had trained everyone the month before, and people still clicked. Training helps a little; the keys are what saved us.`;

const astronomy = `### [00:00:00]

Let's talk about exoplanets and how we find them.

### [00:02:00]

Most of the planets we know were found by the transit method: you watch a star's brightness dip when a planet passes in front of it. The Kepler mission alone found more than two thousand six hundred confirmed planets.

### [00:05:30]

The radial-velocity method came first historically. The first planet around a sun-like star, 51 Pegasi b, was found that way in 1995.

### [00:08:10]

People ask whether we have found a second Earth. We have found rocky planets in habitable zones, but we cannot yet say whether any of them has water, let alone life. Anyone who tells you otherwise is getting ahead of the data.`;

const leadership = `### [00:00:00]

Jeg skal snakke om hvordan vi organiserte teamene våre etter at vi vokste fra tjue til åtti utviklere.

### [00:02:15]

Vi prøvde først en matriseorganisering. Det fungerte dårlig, fordi ingen visste hvem som eide beslutningene. Etter ett år gikk vi over til produktteam med egne mål.

### [00:05:00]

Hvert team har nå fem til syv personer og en produktleder. Vi har bevisst ikke egne testere; teamene tester selv.

### [00:07:40]

Folk spør om dette gjorde oss raskere. Ærlig talt vet vi ikke. Vi måler ikke ledetid godt nok til å si det. Det vi vet, er at færre folk slutter.`;

/** Paragraphs past which nothing in fixture 10 is said — long enough to pass the cap. */
function longTranscript(): string {
  const topics = [
    "the history of the city's tram network and how its routes changed after the war",
    "maintenance schedules for the older rolling stock and the spare-parts problem",
    "how ticket pricing was set by the council and later by the transport company",
    "the debate about extending the line to the hospital and the cost estimates",
    "passenger counts measured by hand in the early years and by sensors today",
    "the depot fire and the months of reduced service that followed it",
  ];
  const paras: string[] = [
    "### [00:00:00]\n\nWelcome. This is a long lecture about one city's trams, and I will wander a bit.",
    "The network opened in 1894 with two lines, both horse-drawn for the first five years.",
  ];
  let minute = 1;
  while (paras.join("\n\n").length < 70_000) {
    const topic = topics[paras.length % topics.length]!;
    const hh = String(Math.floor(minute / 60)).padStart(2, "0");
    const mm = String(minute % 60).padStart(2, "0");
    paras.push(
      `### [${hh}:${mm}:00]\n\nAnother point on ${topic}. The archive records for this period are patchy, so most of what I say here comes from the newspapers of the time and from interviews with retired drivers, who remember the details differently from one another. ` +
        `Paragraph ${paras.length} of the lecture keeps returning to ${topic}, because it shaped what came after it in ways the planners did not expect.`,
    );
    minute += 1;
  }
  paras.push(
    "### [02:30:00]\n\nOne last thing before questions: the network was electrified in 1899, and the last horse tram ran that same autumn.",
  );
  return paras.join("\n\n");
}

export const TRANSCRIPT_FIXTURES: TranscriptFixture[] = [
  {
    id: "01-caffeine",
    transcript: sleep,
    claims: [
      { index: 1, title: "Caffeine's half-life in healthy adults is about five to six hours", quote: "Caffeine lingers for five to six hours.", expected: "supported" },
      { index: 2, title: "Nurses who stopped caffeine after noon fell asleep 45 minutes faster", quote: "In the lab study, nurses fell asleep 45 minutes faster after cutting afternoon caffeine.", expected: "contradicts transcript", webVerdict: "❌" },
      { index: 3, title: "The speaker says decaf coffee is completely caffeine free", quote: "Decaf, the speaker notes, is completely caffeine free.", expected: "contradicts transcript" },
      { index: 4, title: "Caffeine blocks adenosine receptors in the brain", quote: "Caffeine works by blocking adenosine receptors.", expected: "not in transcript", webVerdict: "✅" },
    ],
  },
  {
    id: "02-heat-pumps",
    transcript: climate,
    claims: [
      { index: 1, title: "Modern cold-climate heat pumps keep a COP above two down to -15 °C", quote: "Modern units keep a COP above 2 down to −15 °C.", expected: "supported" },
      { index: 2, title: "Subsidies were the main driver of heat-pump adoption in Norway", quote: "Generous subsidies drove Norway's heat-pump boom.", expected: "contradicts transcript", webVerdict: "⚠️" },
      { index: 3, title: "About six in ten Norwegian detached homes have a heat pump", quote: "Roughly 60 % of detached homes have one.", expected: "supported", webVerdict: "❌" },
      { index: 4, title: "Ground-source heat pumps are always the better choice", quote: "Ground-source always wins over air-source.", expected: "contradicts transcript" },
    ],
  },
  {
    id: "03-startup",
    transcript: startups,
    claims: [
      { index: 1, title: "The second company raised a $1.2 million seed round", quote: "They raised $1.2M at seed.", expected: "supported" },
      { index: 2, title: "The second company failed because the market collapsed", quote: "A collapsing market killed the company.", expected: "contradicts transcript" },
      { index: 3, title: "The speaker advises founders never to take venture money", quote: "His advice: never take VC money.", expected: "contradicts transcript" },
      { index: 4, title: "The third company has twelve employees and is profitable", quote: "Today it is profitable with twelve staff.", expected: "supported" },
      { index: 5, title: "The third company was acquired in 2022", quote: "The bootstrapped company was acquired in 2022.", expected: "not in transcript" },
    ],
  },
  {
    id: "04-rust",
    transcript: rust,
    claims: [
      { index: 1, title: "After the Go-to-Rust migration p99 latency dropped from about 40 ms to about 12 ms", quote: "p99 went from 40 ms to 12 ms.", expected: "supported" },
      { index: 2, title: "The borrow checker was the hardest part of the migration", quote: "The borrow checker was the biggest hurdle.", expected: "contradicts transcript" },
      { index: 3, title: "The migration took two engineers about nine months", quote: "Two engineers, nine months.", expected: "supported" },
      { index: 4, title: "Memory usage fell by 70 percent after the rewrite", quote: "Memory use fell 70 %.", expected: "not in transcript" },
    ],
  },
  {
    id: "05-nutrition",
    transcript: nutrition,
    claims: [
      { index: 1, title: "About 1.6 g of protein per kg of body weight per day covers most athletes", quote: "1.6 g/kg/day is enough for most.", expected: "supported" },
      { index: 2, title: "Protein must be eaten within 30 minutes of training to be effective", quote: "The 30-minute anabolic window is critical.", expected: "contradicts transcript", webVerdict: "❌" },
      { index: 3, title: "Creatine is essential for marathon runners", quote: "Creatine is a must for marathoners.", expected: "contradicts transcript" },
      { index: 4, title: "Athletes training more than ten hours a week are often under-fuelled", quote: "Under-fuelling is the most common mistake among high-volume athletes.", expected: "supported" },
    ],
  },
  {
    id: "06-printing-press",
    transcript: history,
    claims: [
      { index: 1, title: "Gutenberg's Bible was finished around 1455", quote: "The Gutenberg Bible was completed around 1455.", expected: "supported" },
      { index: 2, title: "The printing press caused the Reformation", quote: "The press caused the Reformation.", expected: "contradicts transcript" },
      { index: 3, title: "Within fifty years there were presses in more than 200 European cities", quote: "Over 200 cities had presses within 50 years.", expected: "supported" },
      { index: 4, title: "Luther nailed the theses to the door of the Castle Church in Wittenberg", quote: "Luther nailed his theses to the church door.", expected: "not in transcript", webVerdict: "⚠️" },
    ],
  },
  {
    id: "07-phishing",
    transcript: security,
    claims: [
      { index: 1, title: "Eleven people entered their credentials in the phishing campaign", quote: "Eleven employees typed in their passwords.", expected: "supported" },
      { index: 2, title: "Hardware security keys made the stolen passwords useless", quote: "Security keys stopped the attack.", expected: "supported" },
      { index: 3, title: "User training was what stopped the phishing attack", quote: "Training saved the bank.", expected: "contradicts transcript" },
      { index: 4, title: "About 40 percent of recipients clicked the phishing link", quote: "Some 40 % clicked.", expected: "contradicts transcript" },
      { index: 5, title: "The attackers were a state-sponsored group", quote: "A state-backed group was behind it.", expected: "not in transcript" },
    ],
  },
  {
    id: "08-exoplanets",
    transcript: astronomy,
    claims: [
      { index: 1, title: "51 Pegasi b was found by the radial-velocity method in 1995", quote: "51 Peg b, 1995, radial velocity.", expected: "supported" },
      { index: 2, title: "Kepler found more than 2,600 confirmed planets", quote: "Kepler confirmed over 2,600 planets.", expected: "supported" },
      { index: 3, title: "Astronomers have found water on a rocky habitable-zone planet", quote: "Water has been found on a rocky world in the habitable zone.", expected: "contradicts transcript" },
      { index: 4, title: "The James Webb telescope will find a second Earth by 2030", quote: "JWST will find Earth 2.0 by 2030.", expected: "not in transcript" },
    ],
  },
  {
    id: "09-team-structure-nb",
    transcript: leadership,
    claims: [
      { index: 1, title: "Selskapet gikk fra matriseorganisering til produktteam etter ett år", quote: "Etter ett år byttet de til produktteam.", expected: "supported" },
      { index: 2, title: "Hvert team har fem til syv personer og egne testere", quote: "Teamene har fem til syv personer og egne testere.", expected: "contradicts transcript" },
      { index: 3, title: "Omorganiseringen halverte ledetiden", quote: "Ledetiden ble halvert.", expected: "contradicts transcript" },
      { index: 4, title: "Færre utviklere slutter etter omorganiseringen", quote: "Turnover gikk ned.", expected: "supported" },
    ],
  },
  {
    id: "10-trams-long",
    transcript: longTranscript(),
    claims: [
      { index: 1, title: "The tram network opened in 1894 with two lines", quote: "It opened in 1894 with two lines.", expected: "supported" },
      { index: 2, title: "The network opened with four electric lines", quote: "Four electric lines opened at once.", expected: "contradicts transcript" },
      // Said only at 02:30:00, past the 60,000-character cut: under the cap the
      // correct verdict is "not in transcript", and the note should say so.
      { index: 3, title: "The network was electrified in 1899", quote: "Electrification came in 1899.", expected: "not in transcript" },
    ],
  },
];
