import { writeFile } from 'node:fs/promises';
import { getSyllabus } from '../src/mportal-client.js';
const [year, term, campcd, sust, sbjtno1, clssno1, output] = process.argv.slice(2);
async function main() {
  if (!output) throw new Error('Usage: tsx scripts/probe-oz-syllabus.ts <year> <term> <campus> <sust> <course> <section> <new-output.json>');
  const result = await getSyllabus({ year, term, campcd, sust, sbjtno1, clssno1 });
  if (!result.ok) throw new Error(result.error_code);
  await writeFile(output, JSON.stringify(result.document, null, 2)+'\n', {flag:'wx', mode:0o600});
  console.log(JSON.stringify({ course_identity_matches: result.document.basic.course_code === sbjtno1,
    textbook_count: result.document.textbooks.length, assessment_count: result.document.assessment.length,
    schedule_count: result.document.schedule.length, source_text_present: result.document.raw_text.length > 0 }));
}
main().catch(() => { console.error('Syllabus HTTP probe failed.'); process.exitCode = 1; });
