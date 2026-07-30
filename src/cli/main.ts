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
import { cmdHouseholds, cmdIngest, cmdIngestLive, cmdReport, cmdReview, generateNarrative } from "./commands.ts";
import { cmdManual } from "./manual.ts";

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
  manual <run-id> --household <id>       enter a parked document by hand
  report --household <id> --asof <date>  compute results, and --html the report

Common flags:
  --data-root <dir>        where household data lives (default ${DEFAULT_DATA_ROOT})
  --offline                refuse ALL network egress, for every command
  --input <file>           a filled-in parse output (manual)
  --accept-all             accept every line of a run (review)
  --reaccept               reverse a prior acceptance and apply the run again
  --decisions <file>       per-line decisions JSON (review)
  --confirm-metadata <f>   instrument name -> confirmed type/domicile (review)
  --html                   also render the mobile-first client report
  --deck                   also render the paged screen-sharing deck
  --benchmark a=0.6,b=0.4  assign a composite benchmark (report)
  --narrate                add AI commentary; numbers are validated against
                           the computed results and dropped if invented

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
  // §9: --offline "disables all egress". It is a property of the run, not of
  // one subcommand, so it is checked here for every path that could transmit.
  const offlineMode = flags.offline === true;
  // The single point at which wall-clock time enters the system.
  // Full millisecond precision: truncating to whole seconds widens every
  // id-collision window a thousandfold for no benefit.
  const now = () => new Date().toISOString();

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
      const offline = offlineMode || !apiKey;
      const result = offline
        ? cmdIngest({ dataRoot, householdId, file, offline: true, now })
        : await cmdIngestLive({ dataRoot, householdId, file, apiKey: apiKey!, now });
      console.log(`Parsed ${file} as run ${result.runId} (${result.extractor}, ${result.accountsFound} account(s)).`);
      console.log(`Review it: ${result.reviewPath}`);
      console.log(`Then: meridian review ${result.runId} --household ${householdId} --accept-all`);
      return 0;
    }

    case "manual": {
      const runId = positional[1];
      if (!runId) throw new Error("manual: expected the parked run id");
      const result = cmdManual({
        dataRoot,
        householdId: requireFlag(flags, "household"),
        runId,
        ...(typeof flags.input === "string" ? { inputPath: flags.input } : {}),
        ...(typeof flags.operator === "string" ? { operatorInitials: flags.operator } : {}),
        now,
      });
      if (result.template) {
        console.log(`Wrote a template for ${result.accountsFound} account(s): ${result.reviewPath}`);
        console.log("Fill it in from the document, then:");
        console.log(`  meridian manual ${runId} --household <id> --input <that file>`);
      } else {
        console.log(`Entered manually as run ${result.runId} (${result.accountsFound} account(s)).`);
        console.log(`Review it: ${result.reviewPath}`);
        console.log(`Then: meridian review ${result.runId} --household <id> --accept-all`);
      }
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
        reaccept: flags.reaccept === true,
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
      const householdId = requireFlag(flags, "household");
      const asof = requireFlag(flags, "asof");
      const benchmarkWeights =
        typeof flags.benchmark === "string"
          ? Object.fromEntries(
              flags.benchmark.split(",").map((part) => {
                const [name, weight] = part.split("=");
                return [name!.trim(), Number(weight)];
              })
            )
          : undefined;

      // --narrate needs the computed results first: the model only ever
      // describes numbers the engine already produced (SPEC §2.1, §8).
      let narrative;
      if (flags.narrate) {
        if (offlineMode) {
          throw new Error("report --narrate cannot run with --offline: generating commentary requires an API call");
        }
        const apiKey = typeof flags["api-key"] === "string" ? flags["api-key"] : process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error("report --narrate: pass --api-key or set ANTHROPIC_API_KEY");
        const draft = cmdReport({ dataRoot, householdId, asof, now, ...(benchmarkWeights ? { benchmarkWeights } : {}) });
        const generated = await generateNarrative(draft.results, { apiKey, now });
        narrative = generated.narrative;
        for (const rejection of generated.rejected) console.log(`  ! commentary omitted — ${rejection}`);
      }

      const { resultsPath, results, reportPath, deckPath } = cmdReport({
        dataRoot,
        householdId,
        asof,
        now,
        html: flags.html === true || flags.narrate === true,
        deck: flags.deck === true,
        ...(benchmarkWeights ? { benchmarkWeights } : {}),
        ...(narrative ? { narrative } : {}),
      });
      const total = results.consolidation.total;
      const secondary = total.secondary ? ` / ${total.secondary.currency} ${total.secondary.amount.toLocaleString("en-GB")}` : "";
      console.log(`Total wealth ${total.base.currency} ${total.base.amount.toLocaleString("en-GB")}${secondary} as at ${results.meta.asof}`);
      if (results.usConnect) {
        console.log(`US-connected: ${(results.usConnect as { criticalCount: number }).criticalCount} critical flag(s).`);
      }
      for (const warning of results.warnings) console.log(`  ! ${warning}`);
      console.log(`Results: ${resultsPath}`);
      if (reportPath) console.log(`Report:  ${reportPath}`);
      if (deckPath) console.log(`Deck:    ${deckPath}`);
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
