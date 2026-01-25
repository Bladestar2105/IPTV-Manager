# Branch Status - IPTV-Manager

## Aktuelle Branches

### ✅ v3.0.0 (STABLE - Recommended)
**Letzter Commit:** `411d763` - "feat: Preserve provider channel order instead of alphabetical sorting"

**Enthält:**
- ✅ Kanalreihenfolge in Provider-Reihenfolge (nicht alphabetisch)
- ✅ Category Drag & Drop mit CSS Styles
- ✅ Provider-Isolation pro Benutzer
- ✅ Admin vs User Trennung
- ✅ Alle Sicherheitsfunktionen von v2.5.1
- ✅ 290 EPG-Quellen von open-epg.com
- ✅ Korrigierte EPG-URLs
- ✅ NaN MB Display Fix

**Nicht enthalten:**
- ❌ EPG-Mapping Funktionalität

**Status:** PRODUKTIONSBEREIT

---

### 🚧 feature/epg-mapping (EXPERIMENTAL)
**Letzter Commit:** `3009572` - "feat: Add comprehensive EPG mapping feature"

**Enthält:**
- ✅ Alles von v3.0.0
- ✅ EPG-Mapping System (automatisch & manuell)
- ✅ EPG-Kanal-Suche
- ✅ Auto-Mapping mit Fuzzy Matching

**Probleme:**
- ⚠️ Design ist kaputt nach Implementierung
- ⚠️ Bugfixes (`60bb824`, `cedbc79`, `6de4ad6`) haben Probleme verursacht

**Status:** NICHT VERWENDBAR - Benötigt Debugging

---

### 📦 main (STABLE - v2.5.1)
**Letzter Commit:** v2.5.1 Tag

**Enthält:**
- ✅ Alle Basisfunktionen
- ✅ JWT-Authentifizierung
- ✅ Rate Limiting
- ✅ Provider-Isolation

**Nicht enthalten:**
- ❌ Kanalreihenfolge-Preservation
- ❌ Category Drag & Drop CSS
- ❌ EPG-Mapping

**Status:** STABIL

---

### 📦 v2.0.0 (STABLE - Legacy)
**Letzter Commit:** v2.0.0 Tag

**Enthält:**
- ✅ Alle Basisfunktionen von v2.0.0

**Nicht enthalten:**
- ❌ JWT-Authentifizierung
- ❌ Rate Limiting
- ❌ Kanalreihenfolge-Preservation
- ❌ EPG-Mapping

**Status:** VERALTET

---

## Empfehlung

### Für Produktion: v3.0.0 verwenden
```bash
git checkout v3.0.0
git pull origin v3.0.0
npm install
npm start
```

### Für EPG-Mapping Testing: feature/epg-mapping
```bash
git checkout feature/epg-mapping
git pull origin feature/epg-mapping
npm install
npm start
```

⚠️ **Warnung:** feature/epg-mapping hat Design-Probleme und ist nicht für die Produktion geeignet.

---

## Git History

```
feature/epg-mapping (experimental)
  └─ 3009572 feat: Add comprehensive EPG mapping feature
      └─ 411d763 feat: Preserve provider channel order

v3.0.0 (stable)
  └─ 411d763 feat: Preserve provider channel order
      └─ 562c92f fix: Correct all remaining OCR errors
      └─ 699b87c feat: Replace globetvapp EPG sources
      └─ ... alle stabilen Features

main (v2.5.1)
  └─ v2.5.1 Tag
      └─ alle v2.5.1 Features

v2.0.0 (legacy)
  └─ v2.0.0 Tag
```

---

## Probleme mit feature/epg-mapping

Die Bugfixes nach dem EPG-Mapping haben das Design kaputt gemacht:

1. **Commit 60bb824** - "Fix white screen issue by merging duplicate DOMContentLoaded listeners"
   - Dies hat möglicherweise Event-Listener entfernt die für das Design wichtig waren

2. **Commit cedbc79** - "Fix Move EPG channel search event listener inside DOMContentLoaded"
   - Dies hat Event-Listeners verschoben und möglicherweise andere Funktionen betroffen

3. **Commit 6de4ad6** - "Fix i18n.js syntax error and add missing Greek translations"
   - Syntax-Error-Fix hat möglicherweise andere Probleme verursacht

**Lösung:** EPG-Mapping muss sauber neu implementiert werden ohne diese Bugfixes zu beeinflussen.

---

## Nächste Schritte

1. ✅ v3.0.0 auf stabilen Stand zurückgesetzt (411d763)
2. ✅ EPG-Mapping in separaten Branch verschoben (feature/epg-mapping)
3. ⏳ EPG-Mapping muss debugged werden

**Für den User:**
- Nutze v3.0.0 für die Produktion
- Wenn du EPG-Mapping brauchst, warte bis es in feature/epg-mapping korrigiert ist