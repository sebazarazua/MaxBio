'use client';

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="home-page">
      <p className="eyebrow">ALGO SALIÓ MAL</p>
      <h1>No pudimos mostrar esta página.</h1>
      <p className="intro">Volvé a intentar en unos momentos.</p>
      <button className="secondary-button" onClick={reset}>
        Volver a intentar
      </button>
    </section>
  );
}
