import { ApiError, requestJson } from "../src/client.js";

interface DayStats {
  day: string;
  visits: number;
}

/**
 * Nightly job: pull one day of statistics. Returns a process exit code, so a scheduler can tell
 * "API is down, run again later" (1) from "the token needs a human" (2).
 */
export async function syncDay(day: string): Promise<number> {
  try {
    const stats = await requestJson<DayStats>(`https://api.example.com/stats?day=${day}`, {
      // read lazily, at the moment of use (not at import time)
      init: { headers: { authorization: `Bearer ${process.env.STATS_API_TOKEN}` } },
    });
    console.log(`synced ${stats.day}: ${stats.visits} visits`);
    return 0;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    // ApiError messages never contain the query string, so they are safe to log.
    if (e.kind === "auth_error") {
      console.error(`ALERT, the API token needs a human: ${e.message}`);
      return 2;
    }
    console.error(`sync failed (${e.kind}) after ${e.attempts} attempt(s): ${e.message}`);
    return 1;
  }
}
