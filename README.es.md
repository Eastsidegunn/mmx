[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · Español
> Esta es una traducción del [README.md](README.md) original en inglés (base: 67906d8). Puede que el original esté más actualizado.

**AI agent? Read [AGENTS.md](AGENTS.md) first.**

# mmx

Dibuja con tu agente en el mismo diagrama Mermaid: tú editas la imagen, el agente
ve exactamente qué cambiaste y te responde en la imagen.

![Demo de mmx: una persona edita el diagrama y el agente responde](media/demo.gif)

[![CI](https://github.com/Eastsidegunn/mmx/actions/workflows/ci.yml/badge.svg)](https://github.com/Eastsidegunn/mmx/actions/workflows/ci.yml)
[![crates.io](https://img.shields.io/crates/v/mmx.svg)](https://crates.io/crates/mmx)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Renombra un cuadro, arrastra una flecha nueva, añade una nota y pulsa Enviar.
Tu agente recibe el cambio exacto (qué nodo, qué conexión, tu nota) en lugar de
un párrafo que interpretar, y responde editando el mismo diagrama. Tus
comentarios, flechas discontinuas y estilos se conservan, y la imagen es la misma para los dos.

## Instalación

```bash
curl -LsSf https://github.com/Eastsidegunn/mmx/releases/latest/download/mmx-installer.sh | sh   # or: cargo install mmx
mmx init   # Claude Code skill; add --codex for Codex
mmx --version   # serve, wait, note and diff v2 need 0.4.0 or newer
```

## Pruébalo

1. Pídele a tu agente: *"Dibuja nuestro flujo de pago como `diagram.mmd` con mmx y espera mis cambios."*
2. Ejecuta `mmx serve diagram.mmd` y abre la URL que aparece.
3. Edita sobre la imagen y pulsa Enviar. Tu agente responde en el diagrama.

Funciona con Claude Code, Codex o cualquier agente que pueda ejecutar una CLI.
Todo corre en local: sin cuenta y sin nada alojado en la nube.

## Más información

- [Guía](GUIDE.md) (en inglés): cómo funciona un turno, comandos, limitaciones
- [Detalles de instalación](INSTALL.md) (en inglés)
- [Integrar el editor](editor/README.md) (en inglés)
- [Registro de cambios](CHANGELOG.md) · [Contribuir](CONTRIBUTING.md) · [Seguridad](SECURITY.md) · [Licencia (MIT)](LICENSE) (en inglés)
