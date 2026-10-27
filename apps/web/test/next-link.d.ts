// Test harness only (NodeNext): next/link's CJS typings expose the module namespace as default.
// Same public surface as the app-router Link for the props MaxBio uses.
import type { AnchorHTMLAttributes, ReactNode } from 'react';
declare function Link(
  props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: ReactNode },
): ReactNode;
export default Link;
