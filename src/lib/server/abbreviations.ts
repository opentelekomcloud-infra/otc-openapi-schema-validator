import fs from "node:fs/promises";
import path from "node:path";
import { parseAllowedAbbreviations } from "@/lib/abbreviations";
import { setAllowedAbbreviations } from "@/utils/englishWords";

export async function readAllowedAbbreviations(): Promise<string[]> {
    const content = await fs.readFile(path.join(process.cwd(), "public", "lib", "allowed_abbreviations.txt"), "utf8");
    return parseAllowedAbbreviations(content);
}

export async function loadAllowedAbbreviationsOnServer(): Promise<void> {
    setAllowedAbbreviations(await readAllowedAbbreviations());
}
