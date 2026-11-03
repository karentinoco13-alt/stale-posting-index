// Finds job postings that have been open longer than a threshold (default 90
// days) and drafts a friendly note to the employer, asking them to refresh or
// close the post so job seekers don't spend time on roles that are filled.

const DAY = 864e5;

function daysOpen(job, now = Date.now()) {
  const t = Date.parse(job.postedAt);
  return Number.isFinite(t) ? Math.floor((now - t) / DAY) : null;
}

function draftNote(company, staleJobs, days, csat = null) {
  const n = staleJobs.length;
  const list = staleJobs
    .slice(0, 15)
    .map((j) => `  • ${j.title}${j.location ? ` (${j.location})` : ''}: open ${j.daysOpen} days\n    ${j.url}`)
    .join('\n');
  const more = n > 15 ? `\n  …and ${n - 15} more.` : '';

  const subject = `A friendly note about ${n === 1 ? 'a job posting' : `${n} job postings`} at ${company.name}`;
  const body = `Hello ${company.name} hiring team,

I hope you're doing well. I help job seekers find genuine, current openings, and I came across ${n === 1 ? 'a role' : 'some roles'} on your careers page that ${n === 1 ? 'has' : 'have'} been listed for more than ${days} days:

${list}${more}

In such a busy job market, people put real time and hope into every application, so I wanted to reach out gently rather than just pass this along. If ${n === 1 ? 'this role has' : 'any of these roles have'} already been filled or put on hold, would you consider taking ${n === 1 ? 'it' : 'them'} down? And if you're still searching for the right person, a quick refresh of the post (an updated description, a status note, or an expected timeline) helps candidates know their application will be seen.

${csat && csat.csat !== null ? `I also wanted to share what candidates have told us about applying to ${company.name}: across ${csat.count} ratings, ${csat.csat}% were satisfied with your recruiting team${csat.respondedPct !== null ? `, ${csat.respondedPct}% heard back` : ''}${csat.ghostedPct ? `, and ${csat.ghostedPct}% said they stopped hearing from the team partway through` : ''}. Even a short "we've moved forward with other candidates" message means a great deal to the people waiting.

` : ''}I completely understand that finding the right fit can take time, and some roles are meant to stay open. Thank you for looking at this, and for keeping things clear for the people who want to work with you.

Warm regards`;

  return { subject, body };
}

/**
 * Group postings older than `days` by company and attach a drafted note.
 */
function staleReport(companies, jobs, days = 90, now = Date.now(), csatFor = () => null) {
  const byDomain = new Map();
  for (const j of jobs) {
    const d = daysOpen(j, now);
    if (d === null || d <= days) continue;
    if (!byDomain.has(j.companyDomain)) byDomain.set(j.companyDomain, []);
    byDomain.get(j.companyDomain).push({ id: j.id, title: j.title, location: j.location, url: j.url, postedAt: j.postedAt, daysOpen: d });
  }

  return companies
    .filter((c) => byDomain.has(c.domain))
    .map((c) => {
      const staleJobs = byDomain.get(c.domain).sort((a, b) => b.daysOpen - a.daysOpen);
      const totalJobs = jobs.filter((j) => j.companyDomain === c.domain).length;
      const lastNudge = (c.nudges || []).at(-1) || null;
      return {
        name: c.name,
        domain: c.domain,
        contacts: c.contacts || [],
        careersUrl: c.careersUrl || `https://${c.domain}`,
        totalJobs,
        staleCount: staleJobs.length,
        oldestDays: staleJobs[0].daysOpen,
        staleJobs,
        lastNudge,
        // Allow a new note 30 days after the last one, not before.
        canNudge: !lastNudge || now - Date.parse(lastNudge.at) > 30 * DAY,
        csat: csatFor(c.domain),
        note: draftNote(c, staleJobs, days, csatFor(c.domain)),
      };
    })
    .sort((a, b) => b.staleCount - a.staleCount || b.oldestDays - a.oldestDays);
}

module.exports = { staleReport, draftNote, daysOpen };
