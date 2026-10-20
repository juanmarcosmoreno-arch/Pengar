/** Lleva la pantalla arriba: la ventana (iPhone) y el contenedor con scroll del marco de teléfono (web en pantallas anchas). */
export function scrollToTop() {
  window.scrollTo(0, 0);
  document.querySelector('.app-scroll')?.scrollTo(0, 0);
}
