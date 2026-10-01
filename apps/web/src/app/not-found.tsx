import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="home-page">
      <p className="eyebrow">PÁGINA NO DISPONIBLE</p>
      <h1>No encontramos esta página.</h1>
      <p className="intro">Podés volver al inicio para continuar.</p>
      <Link className="secondary-button" href="/">
        Volver al inicio
      </Link>
    </section>
  );
}
