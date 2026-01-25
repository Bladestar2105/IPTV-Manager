<param name="content">#!/usr/bin/env python3
"""
Skript zum Korrigieren der EPG-Quellen basierend auf dem hochgeladenen Bild.
Die Datei korrigiert OCR-Fehler in den URLs (z.B. 'l' statt '1').
"""

import json
import re

# Aktuelle EPG-Quellen laden
with open('epg_sources.json', 'r') as f:
    data = json.load(f)

sources = data['epg_sources']

print(f'Gesamtzahl der EPG-Quellen: {len(sources)}')

# Fehlerhafte URLs sammeln
errors = []
for i, source in enumerate(sources):
    url = source['url']
    filename = url.split('/')[-1]
    
    # Prüfen auf OCR-Fehler
    if 'l' in filename[:-4] and re.search(r'\d', filename):  # Enthält 'l' und auch eine Zahl
        errors.append((i, filename, url))

print(f'\nGefundene potenzielle OCR-Fehler: {len(errors)}')

for idx, filename, url in errors[:20]:
    print(f'  {idx}: {filename} -> {url}')

# Korrekturanwendung
corrections = 0
for i, source in enumerate(sources):
    url = source['url']
    
    # Korrektur 1: 'l' am Ende vor '.xml' durch '1' ersetzen
    url = re.sub(r'(\w)l\.xml$', r'\g<1>1.xml', url)
    
    # Korrektur 2: 'S' durch '5' ersetzen (Argentinia S5 -> Argentina 5)
    url = re.sub(r'(\w+)S(\d*)\.xml$', r'\1\2.xml', url)
    url = url.replace('S.xml', '1.xml')
    
    # Korrektur 3: Zweifache Fehler
    url = url.replace('ll.xml', 'l1.xml').replace('l1.xml', '11.xml')
    
    if url != source['url']:
        source['url'] = url
        corrections += 1
        print(f'Korrigiert: {source["name"]} -> {url}')

print(f'\n\nDurchgeführte Korrekturen: {corrections}')

# Country Codes korrigieren
country_codes = {
    'Albania': 'al',
    'Argentina': 'ar',
    'Australia': 'au',
    'Austria': 'at',
    'Belgium': 'be',
    'Bulgaria': 'bg',
    'Croatia': 'hr',
    'Czech': 'cz',
    'Denmark': 'dk',
    'Estonia': 'ee',
    'Finland': 'fi',
    'France': 'fr',
    'Germany': 'de',
    'Greece': 'gr',
    'Hungary': 'hu',
    'Iceland': 'is',
    'Ireland': 'ie',
    'Italy': 'it',
    'Latvia': 'lv',
    'Lithuania': 'lt',
    'Luxembourg': 'lu',
    'Moldova': 'md',
    'Netherlands': 'nl',
    'Norway': 'no',
    'Poland': 'pl',
    'Portugal': 'pt',
    'Romania': 'ro',
    'Russia': 'ru',
    'Serbia': 'rs',
    'Slovakia': 'sk',
    'Slovenia': 'si',
    'Spain': 'es',
    'Sweden': 'se',
    'Switzerland': 'ch',
    'Ukraine': 'ua',
    'UK': 'uk',
    'USA': 'us',
}

# Namen und Country Codes aktualisieren
for source in sources:
    name = source['name']
    
    # Country Code basierend auf Namen bestimmen
    for country, code in country_codes.items():
        if country in name:
            source['country_code'] = code
            break

# Korrigierte Datei speichern
with open('epg_sources.json', 'w') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)

print(f'\nKorrigierte EPG-Quellen gespeichert in epg_sources.json')
print(f'Gesamtzahl der Quellen: {len(sources)}')

# Überprüfung
print('\n--- Beispiel der ersten 10 korrigierten Quellen ---')
for i, source in enumerate(sources[:10]):
    print(f"{i+1}. {source['name']}")
    print(f"   URL: {source['url']}")
    print(f"   Country: {source['country_code']}")
    print()
</param>