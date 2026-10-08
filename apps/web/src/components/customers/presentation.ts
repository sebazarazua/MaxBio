export const formatCuit = (value: string) =>
  value.slice(0, 2) + '-' + value.slice(2, 10) + '-' + value.slice(10);
