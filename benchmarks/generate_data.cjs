const fs = require('fs');
const path = require('path');

const NUM_CHANNELS = 50000;
const NUM_CATEGORIES = 100;

const channels = [];
const categories = [];

// Generate Categories
for (let i = 1; i <= NUM_CATEGORIES; i++) {
    categories.push({
        category_id: String(i),
        category_name: `Category ${i}`,
        parent_id: 0
    });
}

// Generate Channels
for (let i = 1; i <= NUM_CHANNELS; i++) {
    const catId = (i % NUM_CATEGORIES) + 1;
    channels.push({
        num: i,
        name: `Channel ${i}`,
        stream_type: 'live',
        stream_id: i,
        stream_icon: '',
        epg_channel_id: `channel.${i}.epg`,
        added: Date.now(),
        category_id: String(catId),
        custom_sid: null,
        tv_archive: 0,
        direct_source: '',
        tv_archive_duration: 0
    });
}

const data = {
    categories,
    channels
};

fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(data, null, 2));
console.log(`Generated ${NUM_CHANNELS} channels and ${NUM_CATEGORIES} categories.`);
