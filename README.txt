To je spletni urejevalnik kode, ki deluje s pomočjo knjižnice CodeMirror. Urejevalnik deluje podobno kot običajni urejevalniki kode, uporabnik pa lahko izbira med jeziki Java, C in C++. Med pisanjem se koda sproti shranjuje. Za vsak jezik je vzpostavljena povezava z ustreznim jezikovnim strežnikom: za Javo se uporablja Eclipse JDT Language Server, za C in C++ pa clangd. Povezava med spletnim urejevalnikom in jezikovnima strežnikoma poteka prek WebSocket mostu.

Za delovanje urejevalnika je glavna datoteka editorMain.js, ki skrbi za komunikacijo s strežniki. Datoteka server.js v mapi langserver pa skrbi za zagon strežnikov in posredovanje podatkov med urejevalnikom ter jezikovnimi strežniki.

Da spletni urejevalnik in strežniki pravilno začnejo delovati, je treba narediti naslednje:

1. Gostiti spletni urejevalnik
Spletni urejevalnik mora biti pravilno naložen na spletni strežnik. V HTML datoteko je treba vključiti povezave do vseh pomembnih datotek, kot na primereditorMain.js
2. Zagnati strežnik
V terminalu ali PowerShellu je treba izvesti naslednje ukaze:
  -cd C:\pot-do-datoteke\smartCodev3\langserver\js
  -docker build --no-cache -t smartcode-lsp . (zgradi Docker sliko, v kateri so pripravljeni strežnik, clangd, Eclipse JDT Language Server in vsa potrebna    konfiguracija za povezavo)
  -docker run --rm -it -p 3000:3000 -v "C:\xampp\htdocs\smartCode\workspace:/workspace" --name smartcode-lsp smartcode-lsp (zažene strežnik in vzpostavi delovanje sistema, ki posreduje podatke med spletnim urejevalnikom in jezikovnimi strežniki)

Pride lahko tudi do kasnejse delovanja strežnika zato je pomembno, da se osveži stran in malo pocaka. 







This product includes Eclipse JDT Language Server
Copyright (c) Eclipse contributors
License: Eclipse Public License 2.0 (EPL-2.0)

This product includes clangd / LLVM Project components
Copyright (c) LLVM Project contributors
License: Apache License 2.0 with LLVM Exceptions