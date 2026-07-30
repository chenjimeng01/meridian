#!/usr/bin/env node
// Operator CLI entry point (SPEC §3, §10 Phase 4).
//
//   meridian households create --config <file> [--data-root <dir>]
//   meridian households list
//   meridian ingest <file> --household <id> [--offline] [--api-key <key>]
//   meridian review <run-id> --household <id> (--accept-all | --decisions <file>)
//                            [--confirm-metadata <file>] [--operator <initials>]
//   meridian report --household <id> --asof <YYYY-MM-DD>
//
// This file is the only place the real clock is read.
import { cmdHouseholds, cmdIngest, cmdIngestLive, cmdReport, cmdReview } from "./commands.ts";

const DEFAULT_DATA_ROOT = "./data";

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return { positional, flags };
}

const USAGE = `meridian — cross-border wealth intelligence (v0, local-first)

  households create --config <file>      create a household from a config file
  households list                        list households under the data root
  ingest <file> --household <id>         parse a statement into a review file
  review <run-id> --household <id>       accept/reject a parse run's lines
  report --household <id> --asof <date>  compute the results JSON

Common flags:
  --data-root <dir>        where household data lives (default ${DEFAULT_DATA_ROOT})
  --offline                refuse all network egress (ingest)
  --accept-all             accept every line of a run (review)
  --decisions <file>       per-line decisions JSON (review)
  --confirm-metadata <f>   instrument name -> confirmed type/domicile (review)

Analysis and information only. Not a personal recommendation. Not tax advice.`;

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const value = flags[name];
  if (typeof value !== "string") throw new Error(`missing required --${name}`);
  return value;
}

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  if (!command || flags.help) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  const dataRoot = typeof flags["data-root"] === "string" ? flags["data-root"] : DEFAULT_DATA_ROOT;
  // The single point at which wall-clock time enters the system.
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  switch (command) {
    case "households": {
      const action = positional[1];
      if (action === "list") {
        const { households } = cmdHouseholds({ dataRoot, action: "list", now });
        if (!households.length) {
          console.log(`No households under ${dataRoot}. Create one with: meridian households create --config <file>`);
          return 0;
        }
        for (const h of households) console.log(`${h.id}  ${h.persons} person(s)  base ${h.baseCurrency}`);
        return 0;
      }
      if (action === "create") {
        const { householdId } = cmdHouseholds({ dataRoot, action: "create", configPath: requireFlag(flags, "config"), now });
        console.log(`Created household ${householdId} under ${dataRoot}`);
        console.log("The vault holding real names and account numbers is owner-only and is never committed.");
        return 0;
      }
      console.error(`households: expected "create" or "list"`);
      return 1;
    }

    case "ingest": {
      const file = positional[1];
      if (!file) throw new Error("ingest: expected a file path");
      const householdId = requireFlag(flags, "household");
      const apiKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;
      const offline = flags.offline === true || !apiKey;
      const result = offline
        ? cmdIngest({ dataRoot, householdId, file, offline: true, now })
        : await cmdIngestLive({ dataRoot, householdId, file, apiKey: apiKey!, now });
      console.log(`Parsed ${file} as run ${result.runId} (${result.extractor}, ${result.accountsFound} account(s)).`);
      console.log(`Review it: ${result.reviewPath}`);
      console.log(`Then: meridian review ${result.runId} --household ${householdId} --accept-all`);
      return 0;
    }

    case "review": {
      const runId = positional[1];
      if (!runId) throw new Error("review: expected a run id");
      const result = cmdReview({
        dataRoot,
        householdId: requireFlag(flags, "household"),
        runId,
        acceptAll: flags["accept-all"] === true,
        ...(typeof flags.decisions === "string" ? { decisionsPath: flags.decisions } : {}),
        ...(typeof flags["confirm-metadata"] === "string" ? { confirmMetadataPath: flags["confirm-metadata"] } : {}),
        ...(typeof flags.operator === "string" ? { operatorInitials: flags.operator } : {}),
        now,
      });
      console.log(
        `Accepted ${result.accepted}, edited ${result.edited}, rejected ${result.rejected}; ` +
          `${result.metadataConfirmed} instrument metadata confirmation(s).`
      );
      return 0;
    }

    case "report": {
      const { resultsPath, results } = cmdReport({
        dataRoot,
        householdId: requireFlag(flags, "household"),
        asof: requireFlag(flags, "asof"),
        now,
      });
      const total = results.consolidation.total;
      const secondary = total.secondary ? ` / ${total.secondary.currency} ${total.secondary.amount.toLocaleString("en-GB")}` : "";
      console.log(`Total wealth ${total.base.currency} ${total.base.amount.toLocaleString("en-GB")}${secondary} as at ${results.meta.asof}`);
      if (results.usConnect) {
        console.log(`US-connected: ${(results.usConnect as { criticalCount: number }).criticalCount} critical flag(s).`);
      }
      for (const warning of results.warnings) console.log(`  ! ${warning}`);
      console.log(`Results: ${resultsPath}`);
      return 0;
    }

    default:
      console.error(`Unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`meridian: ${(error as Error).message}`);
    process.exit(1);
  });
