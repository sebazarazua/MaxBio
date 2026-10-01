const paths = {
  home: 'M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9',
  products: 'm3 7 9-4 9 4-9 4-9-4Zm0 0v10l9 4 9-4V7M12 11v10M7.5 5 17 9',
  stock: 'M4 3v18M20 3v18M4 10h16M4 18h16M7 4h4v6H7zM13 12h4v6h-4z',
  document: 'M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6',
  billing: 'M5 3h14v18l-3-2-4 2-4-2-3 2V3ZM8 7h8M8 11h8M8 15h4',
  trace: 'M5 4v6M9 4v6M13 4v6M17 4v6M21 4v6M3 16h6M6 13v6M12 16h9M18 13l3 3-3 3',
  clients:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM17 4a4 4 0 0 1 0 7M22 21v-2a4 4 0 0 0-3-3.87',
  suppliers: 'M3 7h11v11H3V7ZM14 11h4l3 4v3h-7M5 18a2 2 0 1 0 4 0M16 18a2 2 0 1 0 4 0',
  check: 'm5 12 4 4L19 6',
  connection: 'M8 12h8M12 8v8M4 4h5M4 4v5M20 4h-5M20 4v5M4 20h5M4 20v-5M20 20h-5M20 20v-5',
} as const;

export function Icon({ name, size = 20 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
