; Personalización del instalador NSIS (auto-incluido por electron-builder).
; Muestra la versión en el instalador: en el título de la ventana y en el branding (abajo).

!macro customHeader
  Caption "SoloQ Overlay v${VERSION} — Instalación"
  BrandingText "SoloQ Overlay v${VERSION}"
!macroend
