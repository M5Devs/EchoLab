export async function initEruda() {
  if (typeof window === 'undefined') return;

  const urlParams = new URLSearchParams(window.location.search);
  const debugQuery = urlParams.get('debug') === 'true';
  const debugSetting = localStorage.getItem('echolab_debug_eruda') === 'true';
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  ) || window.innerWidth < 768;

  if (debugQuery || debugSetting || isMobile) {
    try {
      const eruda = (await import('eruda')).default;
      if (!(window as any).__eruda_initialized) {
        eruda.init();
        (window as any).__eruda_initialized = true;
      }
    } catch (e) {
      console.warn('Failed to initialize Eruda console:', e);
    }
  }
}
