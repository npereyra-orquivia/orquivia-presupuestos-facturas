@echo off
setlocal
title Orquivia - Presupuestos y facturas
cd /d "%~dp0"
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Necesitas instalar Node.js 22.12 o posterior para abrir Orquivia.
  pause
  exit /b 1
)
if not exist "node_modules\vite\package.json" (
  echo Preparando la aplicacion por primera vez...
  call npm.cmd ci
  if errorlevel 1 (
    echo No se pudieron preparar las dependencias.
    pause
    exit /b 1
  )
)
echo Orquivia se abrira en tu navegador.
echo Mantén esta ventana abierta mientras usas el portal.
echo Para cerrar el servidor, pulsa Ctrl+C.
call npm.cmd run dev -- --open
pause
