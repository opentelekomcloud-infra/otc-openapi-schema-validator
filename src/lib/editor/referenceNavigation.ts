import type { Range, StateEffect } from "@codemirror/state";
import { foldedRanges, unfoldEffect } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { isMap, isScalar, isSeq } from "yaml";
import { NativeReferenceError } from "@/lib/openapi/references";
import { sourceMap, type SourceLocation } from "@/lib/openapi/sourceMap";

class ReferenceNavigation {
    decorations: DecorationSet = Decoration.none;
    readonly targets = new Map<string, SourceLocation>();

    constructor(view: EditorView) {
        this.build(view);
    }

    update(update: ViewUpdate) {
        if (update.docChanged) this.build(update.view);
    }

    targetFor(event: MouseEvent): SourceLocation | undefined {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || !(event.target instanceof Element)) return undefined;
        const reference = event.target.closest("[data-openapi-ref]")?.getAttribute("data-openapi-ref");
        return reference ? this.targets.get(reference) : undefined;
    }

    private build(view: EditorView) {
        this.targets.clear();
        const source = sourceMap(view.state.doc.toString());
        const marks: Range<Decoration>[] = [];
        const pending: unknown[] = source.sourceDocument.errors.length ? [] : [source.sourceDocument.contents];
        while (pending.length) {
            const node = pending.pop();
            if (isSeq(node)) {
                for (const item of node.items) pending.push(item);
            } else if (isMap(node)) {
                for (const pair of node.items) {
                    pending.push(pair.value);
                    if (!isScalar(pair.key) || pair.key.value !== "$ref" || !isScalar(pair.value) ||
                        typeof pair.value.value !== "string" || !pair.value.value.startsWith("#") || !pair.value.range) continue;
                    const reference = pair.value.value;
                    if (!this.targets.has(reference)) {
                        try {
                            const target = source.locate(reference);
                            if (target.fallback) continue;
                            this.targets.set(reference, target);
                        } catch (error) {
                            if (error instanceof NativeReferenceError) continue;
                            throw error;
                        }
                    }
                    const [from, to] = pair.value.range;
                    marks.push(Decoration.mark({
                        attributes: {
                            class: "cm-openapi-ref",
                            title: "Ctrl/Cmd+click to go to definition",
                            "data-openapi-ref": reference,
                        },
                    }).range(from, to));
                }
            }
        }
        this.decorations = Decoration.set(marks, true);
    }
}

export const referenceNavigation = [
    ViewPlugin.fromClass(ReferenceNavigation, {
        decorations: (plugin) => plugin.decorations,
        eventHandlers: {
            mousedown(event) {
                return Boolean(this.targetFor(event));
            },
            click(event, view) {
                const target = this.targetFor(event);
                if (!target) return false;
                const effects: StateEffect<unknown>[] = [];
                foldedRanges(view.state).between(target.from, target.from, (from, to) => {
                    effects.push(unfoldEffect.of({ from, to }));
                });
                effects.push(EditorView.scrollIntoView(target.from, { y: "center" }));
                event.preventDefault();
                view.focus();
                view.dispatch({ selection: { anchor: target.from }, effects, userEvent: "select.pointer" });
                return true;
            },
        },
    }),
    EditorView.baseTheme({
        ".cm-openapi-ref": { textDecoration: "underline dotted", textUnderlineOffset: "3px", cursor: "pointer" },
        ".cm-openapi-ref:hover": { textDecorationStyle: "solid" },
    }),
];
