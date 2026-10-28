import type React from "react";
import type { JSX as ScaleJSX } from "@telekom/scale-components/dist/types/components";

type ScaleElements = {
    [Tag in keyof ScaleJSX.IntrinsicElements]: React.HTMLAttributes<HTMLElement> &
        Omit<ScaleJSX.IntrinsicElements[Tag], keyof React.HTMLAttributes<HTMLElement> | "ref"> &
        React.RefAttributes<HTMLElement>;
};

declare module "react" {
    namespace JSX {
        // React custom elements require an interface for declaration merging.
        // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        interface IntrinsicElements extends ScaleElements {}
    }
}
