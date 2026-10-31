// NodeNext test harness: Next Image exposes a CJS namespace as its default type.
// Production continues to use Next's complete image typings.
import type { ImgHTMLAttributes, ReactNode } from 'react';
declare function Image(
  props: ImgHTMLAttributes<HTMLImageElement> & {
    src: string;
    alt: string;
    width: number;
    height: number;
    unoptimized?: boolean;
  },
): ReactNode;
export default Image;
