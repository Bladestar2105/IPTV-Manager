const translations = {
  en: {
    // Title & Headers
    title: 'IPTV Meta Panel',
    userManagement: 'User Management',
    providerManagement: 'Provider Management',
    categoriesChannels: 'User Categories & Channels',
    xtreamLogin: 'Xtream Codes Login',
    
    // User Section
    username: 'Username',
    password: 'Password',
    addUser: 'Add User',
    deleteUserConfirm: 'Really delete user "{name}"?',
    userCreated: '✅ User created',
    
    // Provider Section
    providerName: 'Name',
    providerUrl: 'Provider URL',
    providerUsername: 'Username',
    providerPassword: 'Password',
    epgUrl: 'EPG URL (optional)',
    addProvider: 'Add Provider',
    sync: 'Sync',
    syncing: 'Syncing...',
    syncSuccess: '✅ {count} channels synchronized',
    deleteProviderConfirm: 'Really delete provider "{name}"?',
    providerCreated: '✅ Provider created',
    
    // Category Section
    selectedUser: 'Selected User',
    noUserSelected: 'No user selected',
    importCategories: '📥 Import Provider Categories',
    categoryName: 'Category Name',
    addCategory: 'Add Category',
    dragToSort: '🖐️ Drag & Drop to sort',
    editCategory: 'Edit Category',
    newName: 'New name:',
    deleteCategoryConfirm: 'Really delete category "{name}"?',
    categoryCreated: '✅ Category created',
    markedAsAdult: 'Marked as Adult',
    markAsAdult: 'Mark as Adult',
    
    // Channel Section
    channelAssignment: 'Channel Assignment',
    selectProvider: 'Select Provider',
    selectProviderPlaceholder: '-- Select Provider --',
    searchChannels: '🔍 Search channels...',
    searchChannelsHint: 'Select provider, then search channels',
    providerChannels: 'Provider Channels',
    userChannels: 'User Channels',
    dragToSortChannels: '🖐️ Drag & Drop',
    noChannels: 'No channels assigned',
    pleaseSelectProvider: 'Please select provider',
    noChannelsAvailable: 'No channels available',
    loadingChannels: '⏳ Loading channels...',
    loadingError: '❌ Loading error',
    noResults: '🔍 No results for "{search}"',
    moreChannels: '... and {count} more (refine search)',
    selectUserAndCategory: '⚠️ Please select user and category',
    
    // Import Modal
    importCategoriesTitle: 'Import Provider Categories',
    searchCategories: '🔍 Search categories...',
    loadingCategories: 'Loading categories...',
    noCategoriesFound: 'No categories found',
    channels: 'channels',
    importCategoryOnly: '📥 Category Only',
    importWithChannels: '📥 With Channels',
    close: 'Close',
    categoryImportedOnly: '✅ Category "{name}" created (without channels)',
    categoryImportedWithChannels: '✅ Category "{name}" imported with {count} channels',
    markedAsAdultContent: '🔞 Marked as Adult Content',
    
    // Xtream Info
    url: 'URL',
    epgUrlLabel: 'EPG URL',
    passwordPlaceholder: '<Your Password>',
    
    // Alerts & Errors
    pleaseSelectUserFirst: '⚠️ Please select a user first',
    pleaseSelectProvider: '⚠️ Please select a provider',
    error: '❌ Error',
    errorPrefix: '❌ Error:',
    
    // Buttons
    delete: '🗑',
    edit: '✏️',
    adult: '🔞',
    add: '+',
    
    // Loading states
    loading: 'Loading...',
    saving: 'Saving...'
  },
  
  de: {
    // Title & Headers
    title: 'IPTV Meta Panel',
    userManagement: 'User-Verwaltung',
    providerManagement: 'Provider-Verwaltung',
    categoriesChannels: 'User-Kategorien & Kanäle',
    xtreamLogin: 'Xtream Codes Login',
    
    // User Section
    username: 'Benutzername',
    password: 'Passwort',
    addUser: 'User+',
    deleteUserConfirm: 'User "{name}" wirklich löschen?',
    userCreated: '✅ User angelegt',
    
    // Provider Section
    providerName: 'Name',
    providerUrl: 'Provider URL',
    providerUsername: 'Benutzername',
    providerPassword: 'Passwort',
    epgUrl: 'EPG URL (optional)',
    addProvider: 'Provider+',
    sync: 'Sync',
    syncing: 'Sync...',
    syncSuccess: '✅ {count} Kanäle synchronisiert',
    deleteProviderConfirm: 'Provider "{name}" wirklich löschen?',
    providerCreated: '✅ Provider angelegt',
    
    // Category Section
    selectedUser: 'Ausgewählter User',
    noUserSelected: 'Kein User gewählt',
    importCategories: '📥 Provider-Kategorien importieren',
    categoryName: 'Kategorie-Name',
    addCategory: 'Kategorie+',
    dragToSort: '🖐️ Drag & Drop zum Sortieren',
    editCategory: 'Kategorie bearbeiten',
    newName: 'Neuer Name:',
    deleteCategoryConfirm: 'Kategorie "{name}" wirklich löschen?',
    categoryCreated: '✅ Kategorie angelegt',
    markedAsAdult: 'Als Adult markiert',
    markAsAdult: 'Als Adult markieren',
    
    // Channel Section
    channelAssignment: 'Kanalzuordnung',
    selectProvider: 'Provider auswählen',
    selectProviderPlaceholder: '-- Provider wählen --',
    searchChannels: '🔍 Kanäle durchsuchen...',
    searchChannelsHint: 'Provider auswählen, dann Kanäle durchsuchen',
    providerChannels: 'Provider-Kanäle',
    userChannels: 'User-Kanäle',
    dragToSortChannels: '🖐️ Drag & Drop',
    noChannels: 'Keine Kanäle zugeordnet',
    pleaseSelectProvider: 'Bitte Provider auswählen',
    noChannelsAvailable: 'Keine Kanäle vorhanden',
    loadingChannels: '⏳ Lade Kanäle...',
    loadingError: '❌ Fehler beim Laden',
    noResults: '🔍 Keine Treffer für "{search}"',
    moreChannels: '... und {count} weitere (Suche verfeinern)',
    selectUserAndCategory: '⚠️ Bitte User und Kategorie wählen',
    
    // Import Modal
    importCategoriesTitle: 'Provider-Kategorien importieren',
    searchCategories: '🔍 Kategorien durchsuchen...',
    loadingCategories: 'Kategorien werden geladen...',
    noCategoriesFound: 'Keine Kategorien gefunden',
    channels: 'Kanäle',
    importCategoryOnly: '📥 Nur Kategorie',
    importWithChannels: '📥 Mit Kanälen',
    close: 'Schließen',
    categoryImportedOnly: '✅ Kategorie "{name}" erstellt (ohne Kanäle)',
    categoryImportedWithChannels: '✅ Kategorie "{name}" mit {count} Kanälen importiert',
    markedAsAdultContent: '🔞 Als Adult-Content markiert',
    
    // Xtream Info
    url: 'URL',
    epgUrlLabel: 'EPG URL',
    passwordPlaceholder: '<dein Passwort>',
    
    // Alerts & Errors
    pleaseSelectUserFirst: '⚠️ Bitte zuerst einen User auswählen',
    pleaseSelectProvider: '⚠️ Bitte Provider auswählen',
    error: '❌ Fehler',
    errorPrefix: '❌ Fehler:',
    
    // Buttons
    delete: '🗑',
    edit: '✏️',
    adult: '🔞',
    add: '+',
    
    // Loading states
    loading: 'Lädt...',
    saving: 'Speichert...'
  },

  fr: {
    // Title & Headers
    title: 'Panneau Meta IPTV',
    userManagement: 'Gestion des Utilisateurs',
    providerManagement: 'Gestion des Fournisseurs',
    categoriesChannels: 'Catégories et Chaînes Utilisateur',
    xtreamLogin: 'Connexion Xtream Codes',
    
    // User Section
    username: "Nom d'utilisateur",
    password: 'Mot de passe',
    addUser: 'Ajouter Utilisateur',
    deleteUserConfirm: 'Supprimer vraiment l\'utilisateur "{name}" ?',
    userCreated: '✅ Utilisateur créé',
    
    // Provider Section
    providerName: 'Nom',
    providerUrl: 'URL du Fournisseur',
    providerUsername: "Nom d'utilisateur",
    providerPassword: 'Mot de passe',
    epgUrl: 'URL EPG (optionnel)',
    addProvider: 'Ajouter Fournisseur',
    sync: 'Synchro',
    syncing: 'Synchronisation...',
    syncSuccess: '✅ {count} chaînes synchronisées',
    deleteProviderConfirm: 'Supprimer vraiment le fournisseur "{name}" ?',
    providerCreated: '✅ Fournisseur créé',
    
    // Category Section
    selectedUser: 'Utilisateur Sélectionné',
    noUserSelected: 'Aucun utilisateur sélectionné',
    importCategories: '📥 Importer Catégories Fournisseur',
    categoryName: 'Nom de la Catégorie',
    addCategory: 'Ajouter Catégorie',
    dragToSort: '🖐️ Glisser-déposer pour trier',
    editCategory: 'Modifier Catégorie',
    newName: 'Nouveau nom :',
    deleteCategoryConfirm: 'Supprimer vraiment la catégorie "{name}" ?',
    categoryCreated: '✅ Catégorie créée',
    markedAsAdult: 'Marqué comme Adulte',
    markAsAdult: 'Marquer comme Adulte',
    
    // Channel Section
    channelAssignment: 'Attribution des Chaînes',
    selectProvider: 'Sélectionner Fournisseur',
    selectProviderPlaceholder: '-- Sélectionner Fournisseur --',
    searchChannels: '🔍 Rechercher chaînes...',
    searchChannelsHint: 'Sélectionner fournisseur, puis rechercher chaînes',
    providerChannels: 'Chaînes Fournisseur',
    userChannels: 'Chaînes Utilisateur',
    dragToSortChannels: '🖐️ Glisser-déposer',
    noChannels: 'Aucune chaîne attribuée',
    pleaseSelectProvider: 'Veuillez sélectionner un fournisseur',
    noChannelsAvailable: 'Aucune chaîne disponible',
    loadingChannels: '⏳ Chargement des chaînes...',
    loadingError: '❌ Erreur de chargement',
    noResults: '🔍 Aucun résultat pour "{search}"',
    moreChannels: '... et {count} de plus (affiner la recherche)',
    selectUserAndCategory: '⚠️ Veuillez sélectionner utilisateur et catégorie',
    
    // Import Modal
    importCategoriesTitle: 'Importer Catégories Fournisseur',
    searchCategories: '🔍 Rechercher catégories...',
    loadingCategories: 'Chargement des catégories...',
    noCategoriesFound: 'Aucune catégorie trouvée',
    channels: 'chaînes',
    importCategoryOnly: '📥 Catégorie Seule',
    importWithChannels: '📥 Avec Chaînes',
    close: 'Fermer',
    categoryImportedOnly: '✅ Catégorie "{name}" créée (sans chaînes)',
    categoryImportedWithChannels: '✅ Catégorie "{name}" importée avec {count} chaînes',
    markedAsAdultContent: '🔞 Marqué comme Contenu Adulte',
    
    // Xtream Info
    url: 'URL',
    epgUrlLabel: 'URL EPG',
    passwordPlaceholder: '<Votre Mot de Passe>',
    
    // Alerts & Errors
    pleaseSelectUserFirst: '⚠️ Veuillez d\'abord sélectionner un utilisateur',
    pleaseSelectProvider: '⚠️ Veuillez sélectionner un fournisseur',
    error: '❌ Erreur',
    errorPrefix: '❌ Erreur :',
    
    // Buttons
    delete: '🗑',
    edit: '✏️',
    adult: '🔞',
    add: '+',
    
    // Loading states
    loading: 'Chargement...',
    saving: 'Enregistrement...'
  },

  el: {
    // Title & Headers
    title: 'Πίνακας Meta IPTV',
    userManagement: 'Διαχείριση Χρηστών',
    providerManagement: 'Διαχείριση Παρόχων',
    categoriesChannels: 'Κατηγορίες & Κανάλια Χρήστη',
    xtreamLogin: 'Σύνδεση Xtream Codes',
    
    // User Section
    username: 'Όνομα χρήστη',
    password: 'Κωδικός πρόσβασης',
    addUser: 'Προσθήκη Χρήστη',
    deleteUserConfirm: 'Διαγραφή χρήστη "{name}";',
    userCreated: '✅ Χρήστης δημιουργήθηκε',
    
    // Provider Section
    providerName: 'Όνομα',
    providerUrl: 'URL Παρόχου',
    providerUsername: 'Όνομα χρήστη',
    providerPassword: 'Κωδικός πρόσβασης',
    epgUrl: 'URL EPG (προαιρετικό)',
    addProvider: 'Προσθήκη Παρόχου',
    sync: 'Συγχρονισμός',
    syncing: 'Συγχρονισμός...',
    syncSuccess: '✅ {count} κανάλια συγχρονίστηκαν',
    deleteProviderConfirm: 'Διαγραφή παρόχου "{name}";',
    providerCreated: '✅ Πάροχος δημιουργήθηκε',
    
    // Category Section
    selectedUser: 'Επιλεγμένος Χρήστης',
    noUserSelected: 'Δεν επιλέχθηκε χρήστης',
    importCategories: '📥 Εισαγωγή Κατηγοριών Παρόχου',
    categoryName: 'Όνομα Κατηγορίας',
    addCategory: 'Προσθήκη Κατηγορίας',
    dragToSort: '🖐️ Σύρετε & Αποθέστε για ταξινόμηση',
    editCategory: 'Επεξεργασία Κατηγορίας',
    newName: 'Νέο όνομα:',
    deleteCategoryConfirm: 'Διαγραφή κατηγορίας "{name}";',
    categoryCreated: '✅ Κατηγορία δημιουργήθηκε',
    markedAsAdult: 'Σημειώθηκε ως Ενήλικων',
    markAsAdult: 'Σημείωση ως Ενήλικων',
    
    // Channel Section
    channelAssignment: 'Ανάθεση Καναλιών',
    selectProvider: 'Επιλογή Παρόχου',
    selectProviderPlaceholder: '-- Επιλέξτε Πάροχο --',
    searchChannels: '🔍 Αναζήτηση καναλιών...',
    searchChannelsHint: 'Επιλέξτε πάροχο και αναζητήστε κανάλια',
    providerChannels: 'Κανάλια Παρόχου',
    userChannels: 'Κανάλια Χρήστη',
    dragToSortChannels: '🖐️ Σύρετε & Αποθέστε',
    noChannels: 'Δεν υπάρχουν κανάλια',
    pleaseSelectProvider: 'Παρακαλώ επιλέξτε πάροχο',
    noChannelsAvailable: 'Δεν υπάρχουν διαθέσιμα κανάλια',
    loadingChannels: '⏳ Φόρτωση καναλιών...',
    loadingError: '❌ Σφάλμα φόρτωσης',
    noResults: '🔍 Δεν βρέθηκαν αποτελέσματα για "{search}"',
    moreChannels: '... και {count} ακόμα (βελτιώστε την αναζήτηση)',
    selectUserAndCategory: '⚠️ Επιλέξτε χρήστη και κατηγορία',
    
    // Import Modal
    importCategoriesTitle: 'Εισαγωγή Κατηγοριών Παρόχου',
    searchCategories: '🔍 Αναζήτηση κατηγοριών...',
    loadingCategories: 'Φόρτωση κατηγοριών...',
    noCategoriesFound: 'Δεν βρέθηκαν κατηγορίες',
    channels: 'κανάλια',
    importCategoryOnly: '📥 Μόνο Κατηγορία',
    importWithChannels: '📥 Με Κανάλια',
    close: 'Κλείσιμο',
    categoryImportedOnly: '✅ Κατηγορία "{name}" δημιουργήθηκε (χωρίς κανάλια)',
    categoryImportedWithChannels: '✅ Κατηγορία "{name}" εισήχθη με {count} κανάλια',
    markedAsAdultContent: '🔞 Σημειώθηκε ως Περιεχόμενο Ενηλίκων',
    
    // Xtream Info
    url: 'URL',
    epgUrlLabel: 'URL EPG',
    passwordPlaceholder: '<Ο Κωδικός σας>',
    
    // Alerts & Errors
    pleaseSelectUserFirst: '⚠️ Παρακαλώ επιλέξτε πρώτα έναν χρήστη',
    pleaseSelectProvider: '⚠️ Παρακαλώ επιλέξτε πάροχο',
    error: '❌ Σφάλμα',
    errorPrefix: '❌ Σφάλμα:',
    
    // Buttons
    delete: '🗑',
    edit: '✏️',
    adult: '🔞',
    add: '+',
    
    // Loading states
    loading: 'Φόρτωση...',
    saving: 'Αποθήκευση...'
  }
};

// Sprache automatisch erkennen
function detectLanguage() {
  const browserLang = navigator.language || navigator.userLanguage;
  const langCode = browserLang.split('-')[0]; // 'de-DE' -> 'de'
  
  // Prüfen ob Sprache verfügbar ist, sonst Fallback zu 'en'
  return translations[langCode] ? langCode : 'en';
}

let currentLang = detectLanguage();

// Translation Funktion
function t(key, replacements = {}) {
  let text = translations[currentLang][key] || translations['en'][key] || key;
  
  // Replacements durchführen (z.B. {name}, {count})
  Object.keys(replacements).forEach(placeholder => {
    text = text.replace(new RegExp(`\\{${placeholder}\\}`, 'g'), replacements[placeholder]);
  });
  
  return text;
}

// Sprache wechseln
function setLanguage(lang) {
  if (translations[lang]) {
    currentLang = lang;
    localStorage.setItem('language', lang);
    return true;
  }
  return false;
}

// Gespeicherte Sprache laden
const savedLang = localStorage.getItem('language');
if (savedLang && translations[savedLang]) {
  currentLang = savedLang;
}

// Export für ES6 Module
window.t = t;
window.setLanguage = setLanguage;
window.currentLang = currentLang;
window.availableLanguages = Object.keys(translations);

console.log(`🌍 Language: ${currentLang}`);
