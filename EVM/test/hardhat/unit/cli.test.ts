import { expect } from "chai";
import { parseArg, isYesMainnet, isDryRun } from "../../../scripts/utils/cli";

describe("scripts/utils/cli", () => {
    const originalArgv = process.argv;
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.argv = originalArgv;
        process.env = { ...originalEnv };
    });

    describe("parseArg", () => {
        it("parses --name=value form", () => {
            process.argv = [...originalArgv, "--usdcAmount=1000000"];
            expect(parseArg("usdcAmount")).to.equal("1000000");
        });

        it("falls back to the uppercased env var for a single-word name", () => {
            process.argv = [...originalArgv];
            process.env.AMOUNT = "42";
            expect(parseArg("amount")).to.equal("42");
        });

        it("resolves camelCase names to SNAKE_CASE env vars", () => {
            // `hardhat run` rejects unknown --flags (HH305/HH310), so env vars are the
            // primary operator interface and camelCase names must map to them.
            process.argv = [...originalArgv];
            process.env.USDC_AMOUNT = "42";
            expect(parseArg("usdcAmount")).to.equal("42");

            process.env.MIN_AMOUNT_OUT = "7";
            expect(parseArg("minAmountOut")).to.equal("7");

            process.env.PENDING_END_TIMESTAMP = "99";
            expect(parseArg("pendingEndTimestamp")).to.equal("99");
        });

        it("still honours the legacy literal-uppercase env form (back-compat)", () => {
            // Any existing runbook, shell history, or script passing the old
            // no-underscore spelling must keep working.
            process.argv = [...originalArgv];
            delete process.env.USDC_AMOUNT;
            process.env.USDCAMOUNT = "legacy";
            expect(parseArg("usdcAmount")).to.equal("legacy");

            // And the already-uppercase form is still a no-op transform.
            process.env.USDC_AMOUNT = "42";
            expect(parseArg("USDC_AMOUNT")).to.equal("42");
        });

        it("prefers the SNAKE_CASE form over the legacy form when both are set", () => {
            process.argv = [...originalArgv];
            process.env.USDC_AMOUNT = "snake";
            process.env.USDCAMOUNT = "legacy";
            expect(parseArg("usdcAmount")).to.equal("snake");
        });

        it("converts hyphens to underscores for the env var fallback", () => {
            process.env.PENDING_END_TIMESTAMP = "12345";
            expect(parseArg("pending-end-timestamp")).to.equal("12345");
        });

        it("returns undefined when neither is set", () => {
            process.argv = [...originalArgv];
            delete process.env.SOME_UNSET_ARG;
            expect(parseArg("some-unset-arg")).to.be.undefined;
        });

        it("prefers argv over env when both are set", () => {
            process.argv = [...originalArgv, "--foo=fromArgv"];
            process.env.FOO = "fromEnv";
            expect(parseArg("foo")).to.equal("fromArgv");
        });
    });

    describe("isYesMainnet / isDryRun", () => {
        it("isYesMainnet reflects --yes-mainnet presence", () => {
            process.argv = [...originalArgv];
            delete process.env.YES_MAINNET;
            expect(isYesMainnet()).to.be.false;
            process.argv = [...originalArgv, "--yes-mainnet"];
            expect(isYesMainnet()).to.be.true;
        });

        it("isYesMainnet honours the YES_MAINNET env var (the only form that survives `hardhat run`)", () => {
            // `hardhat run` rejects `--yes-mainnet` with HH305 before the script
            // executes, so the env var is the only way to satisfy `mainnetGuard`.
            process.argv = [...originalArgv];

            delete process.env.YES_MAINNET;
            expect(isYesMainnet()).to.be.false;

            process.env.YES_MAINNET = "true";
            expect(isYesMainnet()).to.be.true;

            process.env.YES_MAINNET = "1";
            expect(isYesMainnet()).to.be.true;

            // Anything else must NOT unlock a mainnet broadcast.
            process.env.YES_MAINNET = "yes";
            expect(isYesMainnet()).to.be.false;
        });

        it("isDryRun reflects DRY_RUN=true", () => {
            delete process.env.DRY_RUN;
            expect(isDryRun()).to.be.false;
            process.env.DRY_RUN = "true";
            expect(isDryRun()).to.be.true;
        });
    });
});
