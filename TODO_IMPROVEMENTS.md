# TODO: IPTV-Manager Improvements

## 1. ✅ EPG Abruflogik überprüfen
- [x] EPG Update Cycle Logik prüfen
- [x] next_update Feld korrekt implementiert
- [x] Scheduler läuft alle 5 Minuten

## 2. 🔄 Scrollfunktion für lange Listen
- [ ] Kanalliste: Scrollbar hinzufügen
- [ ] EPG-Quellen-Liste: Scrollbar hinzufügen
- [ ] Provider-Liste: Scrollbar hinzufügen
- [ ] CSS für max-height und overflow-y: auto

## 3. 🔄 Provider-Listen pro User isolieren
- [ ] Providers Tabelle um user_id erweitern
- [ ] API-Endpoints anpassen (nur eigene Provider anzeigen)
- [ ] Migration für bestehende Provider

## 4. 🔄 Rate-Limit Problem beheben
- [ ] Delay von 150ms auf 500ms erhöhen
- [ ] Batch-Processing implementieren (10 Länder pro Request)
- [ ] Besseres Caching (24h statt 1h)
- [ ] Retry-Logik bei Rate-Limit

## 5. 🔄 Lizenz-Header hinzufügen
- [ ] server.js: Header mit Bladestar2105
- [ ] app.js: Header mit Bladestar2105
- [ ] i18n.js: Header mit Bladestar2105
- [ ] index.html: Meta-Tag mit Autor
- [ ] style.css: Header mit Bladestar2105

## 6. 🔄 README aktualisieren
- [ ] Rechtlicher Hinweis: "Nur zu Schulungszwecken"
- [ ] Disclaimer hinzufügen
- [ ] Autor: Bladestar2105

## 7. 🔄 Testen mit T-Rex Provider
- [ ] Provider hinzufügen (NICHT ins Git!)
- [ ] EPG-Abruf testen
- [ ] Kanal-Sync testen
- [ ] Alle Features durchgehen