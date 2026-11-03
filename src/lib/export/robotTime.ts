export function formatRobotTime(ms: number): string {
    const iso = new Date(ms).toISOString();
    return `${iso.slice(0, 10).replace(/-/g, "")} ${iso.slice(11, 23)}`;
}

export function robotReportStartTime(xml: string): string {
    const root = xml.match(/<robot\b[^>]*>/)?.[0];
    const generated = root?.match(/\bgenerated=(["'])(.*?)\1/)?.[2];
    const match = generated?.match(/^(\d{4})(\d{2})(\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})$/);
    if (!match) throw new Error("Robot report must declare a valid generated timestamp.");
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}Z`;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms) || formatRobotTime(ms) !== generated) {
        throw new Error("Robot report must declare a valid generated timestamp.");
    }
    return iso;
}
