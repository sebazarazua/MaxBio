import Image from 'next/image';

export function BrandLogo() {
  return (
    <Image
      src="/brand/maxbio-logo.png"
      alt=""
      width={558}
      height={525}
      sizes="80px"
      loading="eager"
      className="brand-logo"
    />
  );
}
