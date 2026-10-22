import fs from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { getSource } from "@/functions/common";
import { mapSeverity } from "@/utils/mapSeverity";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import { coverageLedger, additionalCoverageGaps, type CoverageEntry } from "../fixtures/dual-version/coverageLedger";
import {
    buildScenario, scenarioDefinition, type Dialect, type Variant,
} from "../fixtures/dual-version/scenarios";

jest.mock("@/utils/utils", () => ({
    fetchRepoMap: jest.fn(),
    fetchSpecFromGitea: jest.fn(),
}));
jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Fixture tests must not convert documents."); }),
    convertObj: jest.fn(() => { throw new Error("Fixture tests must not convert documents."); }),
}));

const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
const repoMap = jest.mocked(fetchRepoMap);
const fetchBaseline = jest.mocked(fetchSpecFromGitea);
const rules = new Map<string, AutoRule>();
let baselineKey = 0;

beforeAll(async () => {
    const root = path.join(process.cwd(), "public/rulesets/default");
    const files = (await fs.readdir(root)).filter((file) => file.endsWith(".yaml")).map((file) => path.join(root, file));
    const catalog = await loadRuleCatalog(files, (file) => fs.readFile(file, "utf8"));
    for (const rule of getImplementedRules(catalog, functionsMap)) rules.set(rule.id, rule);
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network access is forbidden in fixture tests."));
    repoMap.mockRejectedValue(new Error("Unexpected baseline lookup."));
    fetchBaseline.mockRejectedValue(new Error("Unexpected baseline fetch."));
});

afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

function ruleFor(entry: CoverageEntry): AutoRule {
    const rule = rules.get(entry.ruleId);
    if (!rule) throw new Error(`Missing catalog rule: ${entry.ruleId}`);
    return rule;
}

async function checkCase(
    entry: CoverageEntry, dialect: Dialect, variant: Variant, baselineDialect: Dialect = dialect
) {
    const rule = ruleFor(entry);
    const scenario = scenarioDefinition(entry.scenario);
    const spec = buildScenario(entry.scenario, dialect, variant, rule);
    if (scenario.baseline) {
        repoMap.mockResolvedValue({ reponame: `fixture-${++baselineKey}`, filename: "baseline" });
        fetchBaseline.mockResolvedValue(buildScenario(entry.scenario, baselineDialect, "positive", rule));
    }
    const content = yaml.dump(spec, { lineWidth: -1, noRefs: true });
    const { diagnostics } = await runLinter(content, [rule]);
    expect(diagnostics.some((diagnostic) =>
        diagnostic.source === "parser" || diagnostic.message.includes("execution failed")
    )).toBe(false);
    if (scenario.baseline) {
        expect(repoMap).toHaveBeenCalledTimes(1);
        expect(fetchBaseline).toHaveBeenCalledTimes(1);
    } else {
        expect(repoMap).not.toHaveBeenCalled();
        expect(fetchBaseline).not.toHaveBeenCalled();
    }
    if (variant === "positive") {
        expect(diagnostics).toEqual([]);
    } else {
        expect(diagnostics).toHaveLength(1);
        const expectedMessage = scenario.message === "$rule" ? rule.message.trim() : scenario.message;
        expect(diagnostics[0]).toMatchObject({
            ...(scenario.idLocation === "message" ? {} : { source: getSource(rule) }),
            severity: entry.scenario === "uriDepth" ? "info" : mapSeverity(rule.severity),
            message: expect.stringContaining(expectedMessage),
        });
        if (scenario.idLocation === "message") expect(diagnostics[0].message).toContain(rule.id);
        expect(diagnostics[0].from).toBeGreaterThanOrEqual(0);
        expect(diagnostics[0].to).toBeGreaterThanOrEqual(diagnostics[0].from);
        expect(diagnostics[0].to).toBeLessThanOrEqual(content.length);
    }
}

test("coverage ledger matches every implemented ID and its real function binding exactly once", () => {
    expect(coverageLedger).toHaveLength(67);
    expect(new Set(coverageLedger.map((entry) => entry.ruleId)).size).toBe(67);
    expect(coverageLedger.map((entry) => entry.ruleId).sort()).toEqual([...rules.keys()].sort());
    expect(new Set(coverageLedger.map((entry) => entry.functionName)).size).toBe(46);
    for (const entry of coverageLedger) {
        expect(ruleFor(entry).call.function).toBe(entry.functionName);
        const scenario = scenarioDefinition(entry.scenario);
        expect(scenario.positive).not.toBe(scenario.negative);
        expect(scenario.message).not.toBe("");
        if (scenario.nativeV2) {
            expect(scenario.nativeV2.task).toMatch(/T\d+/);
            expect(scenario.nativeV2.reason).not.toBe("");
        }
        if (scenario.mixedBaselineGap) {
            expect(scenario.baseline).toBe(true);
            expect(scenario.mixedBaselineGap.task).toMatch(/T\d+/);
            expect(scenario.mixedBaselineGap.reason).not.toBe("");
        }
    }
    for (const gap of additionalCoverageGaps) {
        expect(ruleFor(gap).call.function).toBe(gap.functionName);
        expect(gap.reason).not.toBe("");
        expect(gap.task).toMatch(/T\d+/);
    }
});

describe.each(additionalCoverageGaps)("$ruleId additional gap [$scenario]", (entry) => {
    const scenario = scenarioDefinition(entry.scenario);
    for (const dialect of ["swagger2", "openapi3"] satisfies Dialect[]) {
        test(`${dialect}: ${scenario.positive}`, () => checkCase(entry, dialect, "positive"));
        test(`${dialect}: negative target fixture is distinct from the positive fixture`, () => {
            expect(buildScenario(entry.scenario, dialect, "negative", ruleFor(entry)))
                .not.toEqual(buildScenario(entry.scenario, dialect, "positive", ruleFor(entry)));
        });
        test.todo(`${dialect} negative -> ${entry.task}: ${scenario.negative}; ${entry.reason}`);
    }
});

describe.each(coverageLedger)("$ruleId -> $functionName [$scenario]", (entry) => {
    const scenario = scenarioDefinition(entry.scenario);
    test(`OpenAPI 3: ${scenario.positive}`, () => checkCase(entry, "openapi3", "positive"));
    test(`OpenAPI 3: ${scenario.negative}`, () => checkCase(entry, "openapi3", "negative"));

    test("has distinct positive/negative native Swagger fixtures, without v3 containers or refs", () => {
        const rule = ruleFor(entry);
        const positive = buildScenario(entry.scenario, "swagger2", "positive", rule);
        const negative = buildScenario(entry.scenario, "swagger2", "negative", rule);
        expect(positive).not.toEqual(negative);
        for (const document of [positive, negative]) {
            expect(document).toHaveProperty("swagger");
            expect(document).not.toHaveProperty("openapi");
            expect(document).not.toHaveProperty("components");
            expect(JSON.stringify(document)).not.toMatch(/"requestBody"|"content"|"#\/components\//);
        }
    });

    if (scenario.nativeV2) {
        test.todo(`Swagger 2 positive -> ${scenario.nativeV2.task}: ${scenario.positive}`);
        test.todo(`Swagger 2 negative -> ${scenario.nativeV2.task}: ${scenario.negative}`);
    } else {
        test(`Swagger 2: ${scenario.positive}`, () => checkCase(entry, "swagger2", "positive"));
        test(`Swagger 2: ${scenario.negative}`, () => checkCase(entry, "swagger2", "negative"));
    }

    if (scenario.baseline) {
        for (const [current, baseline] of [
            ["swagger2", "openapi3"], ["openapi3", "swagger2"],
        ] satisfies [Dialect, Dialect][]) {
            const gap = scenario.nativeV2 ?? scenario.mixedBaselineGap;
            if (gap) {
                test.todo(`${current}/${baseline} baseline positive -> ${gap.task}`);
                test.todo(`${current}/${baseline} baseline negative -> ${gap.task}`);
            } else {
                test(`${current}/${baseline} baseline positive`, () => checkCase(entry, current, "positive", baseline));
                test(`${current}/${baseline} baseline negative`, () => checkCase(entry, current, "negative", baseline));
            }
        }
    }
});
