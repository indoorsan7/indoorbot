import { Client, Collection, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ActivityType } from 'discord.js';
import http from 'http';
// FirebaseのインポートをESモジュール形式に修正
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, signInWithCustomToken } from "firebase/auth";
import { getFirestore, doc, getDoc, setDoc, collection, getDocs, deleteDoc } from "firebase/firestore";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// Webサーバーの起動（Renderのヘルスチェック用）
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is alive!');
});

const port = process.env.PORT || 8000;
server.listen(port, () => {
    console.log(`Web server listening on port ${port}`);
});

// Discordクライアントの初期化
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
    ],
});

client.commands = new Collection();

// Canvas環境で提供されるアプリIDを優先、なければデフォルト値を使用
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-discord-incoin-app';

// Firebase初期化変数
let firebaseApp;
let db;
let auth;
let firebaseAuthUid = 'anonymous'; // Firebase Auth UID

// === いんコインデータ（メモリにキャッシュされ、登録済みユーザーはFirestoreと同期されます） ===
const userDataCache = new Map(); // key: discordUserId, value: { balances: number, bankBalances: number, ... }
const companyDataCache = new Map(); // 会社データキャッシュ
const stockDataCache = new Map(); // 株データキャッシュ: key: companyId, value: { currentPrice: number, priceHistory: [], lastUpdateTime: number }
const channelChatRewards = new Map(); // チャンネルチャット報酬設定用 (Firestoreと同期されます)

// ユーザーデータのデフォルト構造
const defaultUserData = {
    balances: 0,
    bankBalances: 0,
    creditPoints: 5,
    lastWorkTime: 0,
    lastRobTime: 0,
    lastInterestTime: 0,
    punishedForNegativeCredit: false,
    job: '無職', // 初期職業は無職
    isRegistered: false, // 新しいフラグ：登録済みかどうか (trueの場合のみFirestoreに保存)
    subscribers: 0, // Youtuber用
    companyId: null, // 所属する会社のID
    username: '不明なユーザー', // デフォルトのユーザー名
    stocks: {}, // ユーザーが保有する株: { companyId: amount }
};

const defaultCompanyData = {
    name: null,
    ownerId: null,
    dailySalary: 0,
    budget: 0,
    autoDeposit: false,
    members: [], // [{ id: userId, username: "username" }]
    lastPayoutTime: 0, // 最終支払い時刻
    password: null, // 新しく追加: 会社パスワード
};

// 株データのデフォルト構造
const defaultStockData = {
    companyId: null,
    currentPrice: 1000, // 初期株価は1000に設定
    priceHistory: [], // [{ timestamp: number, price: number }]
    lastUpdateTime: 0,
};

// チャンネルチャット報酬のデフォルト構造
const defaultChannelRewardData = {
    min: 0,
    max: 0,
};


// 職業ごとの獲得額設定 (ハードコード)
const jobSettings = new Map([
    ["無職", { min: 1000, max: 1500 }], // 無職を追加 (デフォルトの獲得額)
    ["Youtuber", { minMultiplier: 500, maxMultiplier: 1250 }], // Youtuberは特殊計算なのでmin/maxMultiplier
    ["社長", { minBase: 400000, maxBase: 650000, memberBonus: 30000 }], // 社長職の追加
    ["お肉屋", { min: 2000, max: 2500 }],
    ["魚屋", { min: 4500, max: 7500 }],
    ["レストラン店主", { min: 8000, max: 10000 }],
    ["カフェ店主", { min: 12000, max: 13000 }],
    ["タクシー運転手", { min: 17500, max: 23000 }],
    ["バス運転手", { min: 25000, max: 30000 }],
    ["ホテル支配人", { min: 45000, max: 60000 }],
    ["科学技術者", { min: 70000, max: 80000 }],
    ["公認会計士", { min: 85000, max: 100000 }],
    ["歯科医師", { min: 115000, max: 130000 }],
    ["医者", { min: 140000, max: 175000 }],
    ["航空機操縦士", { min: 150000, max: 210000 }]
]);


// 職業ごとの転職費用 (ハードコード)
const jobChangeCosts = new Map([
    ["無職", 0], // 無職への転職費用は0
    ["Youtuber", 3000],
    ["お肉屋", 100000],
    ["魚屋", 750000],
    ["レストラン店主", 1000000],
    ["カフェ店主", 1700000],
    ["タクシー運転手", 3000000],
    ["バス運転手", 3500000],
    ["ホテル支配人", 5000000],
    ["科学技術者", 6500000],
    ["公認会計士", 7500000],
    ["歯科医師", 8000000],
    ["医者", 11000000],
    ["航空機操縦士", 16500000]
]);

const authChallenges = new Map(); // 認証チャレンジ用（一時データ）
const ticketPanels = new Map();   // チケットパネル設定用（一時データ）

// === Firestore Helper Functions ===

// ユーザーデータ
const getUserDocRef = (discordUserId) => {
    if (!db || firebaseAuthUid === 'anonymous') {
        console.warn('Firestore instance or authenticated UID is not ready. User data operations might not persist.');
        return null;
    }
    if (!discordUserId || discordUserId === '') {
        console.warn(`Attempted to get user doc ref with invalid userId: '${discordUserId}'. Returning null.`);
        return null;
    }
    return doc(collection(db, `artifacts/${appId}/public/data/discord_incoin_data`), discordUserId);
};

// 会社データ
const getCompanyDocRef = (companyId) => {
    if (!db || firebaseAuthUid === 'anonymous') {
        console.warn('Firestore instance or authenticated UID is not ready. Company data operations might not persist.');
        return null;
    }
    if (!companyId || companyId === '') {
        console.warn(`Attempted to get company doc ref with invalid companyId: '${companyId}'. Returning null.`);
        return null;
    }
    return doc(collection(db, `artifacts/${appId}/public/data/companies`), companyId);
};

// 株データ
const getStockDocRef = (companyId) => {
    if (!db || firebaseAuthUid === 'anonymous') {
        console.warn('Firestore instance or authenticated UID is not ready. Stock data operations might not persist.');
        return null;
    }
    if (!companyId || companyId === '') {
        console.warn(`Attempted to get stock doc ref with invalid companyId: '${companyId}'. Returning null.`);
        return null;
    }
    return doc(collection(db, `artifacts/${appId}/public/data/company_stocks`), companyId);
};

// チャンネル報酬データ
const getChannelRewardDocRef = (channelId) => {
    if (!db || firebaseAuthUid === 'anonymous') {
        console.warn('Firestore instance or authenticated UID is not ready. Channel reward data operations might not persist.');
        return null;
    }
    if (!channelId || channelId === '') {
        console.warn(`Attempted to get channel reward doc ref with invalid channelId: '${channelId}'. Returning null.`);
        return null;
    }
    return doc(collection(db, `artifacts/${appId}/public/data/channel_rewards`), channelId);
};


/**
 * ユーザーの全データをメモリキャッシュから取得、またはFirestoreからロードします。
 * 初回アクセス時やデータが存在しない場合はデフォルト値を設定して返します。
 * @param {string} discordUserId - DiscordユーザーID
 * @returns {Promise<Object>} - ユーザーのデータオブジェクト
 */
async function getUserData(discordUserId) {
    if (userDataCache.has(discordUserId)) {
        return userDataCache.get(discordUserId);
    }

    const docRef = getUserDocRef(discordUserId);
    if (!docRef) {
        const data = { ...defaultUserData };
        userDataCache.set(discordUserId, data);
        return data;
    }

    try {
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            // FirestoreからロードしたデータにisRegisteredがなければtrueとみなす（既存ユーザー対応）
            if (data.isRegistered === undefined) {
                data.isRegistered = true;
            }
            // 欠けているデフォルトフィールドを補完
            for (const key in defaultUserData) {
                if (data[key] === undefined) {
                    data[key] = defaultUserData[key];
                }
            }
            userDataCache.set(discordUserId, data);
            return data;
        } else {
            const data = { ...defaultUserData };
            userDataCache.set(discordUserId, data);
            return data;
        }
    } catch (error) {
        console.error(`Error loading user data for ${discordUserId}:`, error);
        const data = { ...defaultUserData };
        userDataCache.set(discordUserId, data);
        return data;
    }
}

/**
 * ユーザーのデータをメモリキャッシュを更新し、登録済みユーザーの場合のみFirestoreに保存します。
 * @param {string} discordUserId - DiscordユーザーID
 * @param {Object} userDataToSave - 更新するデータオブジェクト
 */
async function saveUserDataToFirestore(discordUserId, userDataToSave) {
    if (userDataToSave.isRegistered === undefined) {
        userDataToSave.isRegistered = true;
    }

    const docRef = getUserDocRef(discordUserId);
    if (!docRef) {
        console.warn(`Cannot save user data for ${discordUserId}. Firestore reference not available or invalid userId.`);
        return;
    }

    try {
        await setDoc(docRef, userDataToSave, { merge: true });
        userDataCache.set(discordUserId, userDataToSave);
    } catch (error) {
        console.error(`Error saving user data for ${discordUserId}:`, error);
    }
}


/**
 * ユーザーのデータをメモリキャッシュを更新し、登録済みユーザーの場合のみFirestoreに保存します。
 * @param {string} discordUserId - DiscordユーザーID
 * @param {string} key - 更新するデータオブジェクトのキー (例: 'balances')
 * @param {*} value - 更新する値
 */
async function updateUserDataField(discordUserId, key, value) {
    const data = await getUserData(discordUserId);
    data[key] = value;
    userDataCache.set(discordUserId, data); // キャッシュを更新

    if (data.isRegistered) {
        const docRef = getUserDocRef(discordUserId);
        if (!docRef) {
            console.warn(`Cannot update user data field '${key}' for ${discordUserId}. Firestore reference not available or invalid userId.`);
            return;
        }
        try {
            await setDoc(docRef, data, { merge: true });
        } catch (error) {
            console.error(`Error saving user data for ${discordUserId} (field: ${key}):`, error);
        }
    }
}

// === User Data Getters/Setters (modified to use new functions) ===
async function getCoins(userId) {
    const data = await getUserData(userId);
    return data.balances;
}

async function addCoins(userId, amount) {
    const data = await getUserData(userId);
    const newCoins = data.balances + amount;
    await updateUserDataField(userId, 'balances', Math.max(0, newCoins));
    return Math.max(0, newCoins);
}

async function getBankCoins(userId) {
    const data = await getUserData(userId);
    return data.bankBalances;
}

async function addBankCoins(userId, amount) {
    const data = await getUserData(userId);
    const newBankCoins = data.bankBalances + amount;
    await updateUserDataField(userId, 'bankBalances', Math.max(0, newBankCoins));
    return Math.max(0, newBankCoins);
}

async function getCreditPoints(userId) {
    const data = await getUserData(userId);
    return data.creditPoints;
}

async function addCreditPoints(userId, amount) {
    const data = await getUserData(userId);
    const oldCreditPoints = data.creditPoints;
    const newCreditPoints = oldCreditPoints + amount;
    await updateUserDataField(userId, 'creditPoints', newCreditPoints);
    if (oldCreditPoints < 0 && newCreditPoints >= 0) {
        await setUserPunishedForNegativeCredit(userId, false);
        console.log(`User ${userId}: punishedForNegativeCredit reset to false as creditPoints are now ${newCreditPoints}.`);
    }
    return newCreditPoints;
}

async function getUserJob(userId) {
    const data = await getUserData(userId);
    return data.job;
}

async function setUserJob(userId, jobName) {
    await updateUserDataField(userId, 'job', jobName);
}

async function getUserLastWorkTime(userId) {
    const data = await getUserData(userId);
    return data.lastWorkTime;
}

async function setUserLastWorkTime(userId, timestamp) {
    await updateUserDataField(userId, 'lastWorkTime', timestamp);
}

async function getUserLastRobTime(userId) {
    const data = await getUserData(userId); // Fix: remove duplicate await
    return data.lastRobTime;
}

async function setUserLastRobTime(userId, timestamp) {
    await updateUserDataField(userId, 'lastRobTime', timestamp);
}

async function getUserLastInterestTime(userId) {
    const data = await getUserData(userId);
    return data.lastInterestTime;
}

async function setUserLastInterestTime(userId, timestamp) {
    await updateUserDataField(userId, 'lastInterestTime', timestamp);
}

async function getUserPunishedForNegativeCredit(userId) {
    const data = await getUserData(userId);
    return data.punishedForNegativeCredit;
}

async function setUserPunishedForNegativeCredit(userId, punished) {
    await updateUserDataField(userId, 'punishedForNegativeCredit', punished);
}

async function getSubscribers(userId) {
    const data = await getUserData(userId);
    return data.subscribers;
}

async function setSubscribers(userId, amount) {
    await updateUserDataField(userId, 'subscribers', amount);
}

async function getUserStocks(userId, companyId) {
    const data = await getUserData(userId);
    return data.stocks[companyId] || 0;
}

async function addUserStocks(userId, companyId, amount) {
    const data = await getUserData(userId);
    if (!data.stocks[companyId]) {
        data.stocks[companyId] = 0;
    }
    data.stocks[companyId] = Math.max(0, data.stocks[companyId] + amount);
    await updateUserDataField(userId, 'stocks', data.stocks); // stocksオブジェクト全体を更新
    return data.stocks[companyId];
}

// === Company Data Functions ===
async function getCompanyData(companyId) {
    if (companyDataCache.has(companyId)) {
        return companyDataCache.get(companyId);
    }
    const docRef = getCompanyDocRef(companyId);
    if (!docRef) {
        const data = { ...defaultCompanyData };
        companyDataCache.set(companyId, data);
        return data;
    }
    try {
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            for (const key in defaultCompanyData) {
                if (data[key] === undefined) {
                    data[key] = defaultCompanyData[key];
                }
            }
            // パスワードフィールドがなければnullで初期化
            if (data.password === undefined) {
                data.password = null;
            }
            companyDataCache.set(companyId, data);
            return data;
        } else {
            const data = { ...defaultCompanyData };
            companyDataCache.set(companyId, data);
            return data;
        }
    } catch (error) {
        console.error(`Error loading company data for ${companyId}:`, error);
        const data = { ...defaultCompanyData };
        companyDataCache.set(companyId, data);
        return data;
    }
}

async function saveCompanyDataToFirestore(companyId, companyDataToSave) {
    const docRef = getCompanyDocRef(companyId);
    if (!docRef) {
        console.warn(`Cannot save company data for ${companyId}. Firestore reference not available or invalid companyId.`);
        return;
    }
    try {
        await setDoc(docRef, companyDataToSave, { merge: true });
        companyDataCache.set(companyId, companyDataToSave);
    } catch (error) {
        console.error(`Error saving company data for ${companyId}:`, error);
    }
}

async function updateCompanyDataField(companyId, key, value) {
    const data = await getCompanyData(companyId);
    data[key] = value;
    companyDataCache.set(companyId, data);
    await saveCompanyDataToFirestore(companyId, data);
}

async function deleteCompanyFromFirestore(companyId) {
    const docRef = getCompanyDocRef(companyId);
    if (!docRef) {
        console.warn(`Cannot delete company data for ${companyId}. Firestore reference not available or invalid companyId.`);
        return;
    }
    try {
        await deleteDoc(docRef);
        companyDataCache.delete(companyId);
        // 会社が削除されたら、その株データも削除
        await deleteStockFromFirestore(companyId);
    } catch (error) {
        console.error(`Error deleting company data for ${companyId}:`, error);
    }
}

async function getAllCompanies() {
    if (!db || firebaseAuthUid === 'anonymous') {
        console.warn('Firestore instance or authenticated UID is not ready. Cannot get all companies.');
        return [];
    }
    const companiesCollectionRef = collection(db, `artifacts/${appId}/public/data/companies`);
    const companies = [];
    try {
        const querySnapshot = await getDocs(companiesCollectionRef);
        querySnapshot.forEach(docSnap => {
            const companyId = docSnap.id;
            const data = docSnap.data();
            for (const key in defaultCompanyData) {
                if (data[key] === undefined) {
                    data[key] = defaultCompanyData[key];
                }
            }
            // パスワードフィールドがなければnullで初期化
            if (data.password === undefined) {
                data.password = null;
            }
            companyDataCache.set(companyId, data);
            companies.push({ id: companyId, ...data });
        });
        return companies;
    } catch (error) {
        console.error("Error fetching all companies:", error);
        return [];
    }
}


// === Stock Data Functions ===
async function getStockData(companyId) {
    if (stockDataCache.has(companyId)) {
        return stockDataCache.get(companyId);
    }
    const docRef = getStockDocRef(companyId);
    if (!docRef) {
        const data = { ...defaultStockData, companyId: companyId };
        stockDataCache.set(companyId, data);
        return data;
    }
    try {
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            for (const key in defaultStockData) {
                if (data[key] === undefined) {
                    data[key] = defaultStockData[key];
                }
            }
            stockDataCache.set(companyId, data);
            return data;
        } else {
            const data = { ...defaultStockData, companyId: companyId };
            stockDataCache.set(companyId, data);
            return data;
        }
    } catch (error) {
        console.error(`Error loading stock data for ${companyId}:`, error);
        const data = { ...defaultStockData, companyId: companyId };
        stockDataCache.set(companyId, data);
        return data;
    }
}

async function saveStockDataToFirestore(companyId, stockDataToSave) {
    const docRef = getStockDocRef(companyId);
    if (!docRef) {
        console.warn(`Cannot save stock data for ${companyId}. Firestore reference not available or invalid companyId.`);
        return;
    }
    try {
        await setDoc(docRef, stockDataToSave, { merge: true });
        stockDataCache.set(companyId, stockDataToSave);
    } catch (error) {
        console.error(`Error saving stock data for ${companyId}:`, error);
    }
}

async function updateStockDataField(companyId, key, value) {
    const data = await getStockData(companyId);
    data[key] = value;
    stockDataCache.set(companyId, data);
    await saveStockDataToFirestore(companyId, data);
}

async function deleteStockFromFirestore(companyId) {
    const docRef = getStockDocRef(companyId);
    if (!docRef) {
        console.warn(`Cannot delete stock data for ${companyId}. Firestore reference not available or invalid companyId.`);
        return;
    }
    try {
        await deleteDoc(docRef);
        stockDataCache.delete(companyId);
    } catch (error) {
        console.error(`Error deleting stock data for ${companyId}:`, error);
    }
}

async function getAllStocks() {
    if (!db || firebaseAuthUid === 'anonymous') {
        console.warn('Firestore instance or authenticated UID is not ready. Cannot get all stocks.');
        return [];
    }
    const stocksCollectionRef = collection(db, `artifacts/${appId}/public/data/company_stocks`);
    const stocks = [];
    try {
        const querySnapshot = await getDocs(stocksCollectionRef);
        querySnapshot.forEach(docSnap => {
            const companyId = docSnap.id;
            const data = docSnap.data();
            for (const key in defaultStockData) {
                if (data[key] === undefined) {
                    data[key] = defaultStockData[key];
                }
            }
            stockDataCache.set(companyId, data);
            stocks.push({ id: companyId, ...data });
        });
        return stocks;
    } catch (error) {
        console.error("Error fetching all stocks:", error);
        return [];
    }
}


// === Channel Reward Data Functions ===
/**
 * チャンネル報酬データをメモリキャッシュから取得、またはFirestoreからロードします。
 * @param {string} channelId - チャンネルID
 * @returns {Promise<Object>} - チャンネル報酬データオブジェクト
 */
async function getChannelRewardData(channelId) {
    // まずメモリキャッシュから取得
    if (channelChatRewards.has(channelId)) {
        return channelChatRewards.get(channelId);
    }

    const docRef = getChannelRewardDocRef(channelId);
    if (!docRef) {
        const data = { ...defaultChannelRewardData };
        channelChatRewards.set(channelId, data);
        return data;
    }
    try {
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            for (const key in defaultChannelRewardData) {
                if (data[key] === undefined) {
                    data[key] = defaultChannelRewardData[key];
                }
            }
            channelChatRewards.set(channelId, data);
            return data;
        } else {
            const data = { ...defaultChannelRewardData };
            channelChatRewards.set(channelId, data);
            return data;
        }
    } catch (error) {
        console.error(`Error loading channel reward data for ${channelId}:`, error);
        const data = { ...defaultChannelRewardData };
        channelChatRewards.set(channelId, data);
        return data;
    }
}

/**
 * チャンネル報酬データをメモリキャッシュを更新し、Firestoreに保存します。
 * @param {string} channelId - チャンネルID
 * @param {Object} rewardDataToSave - 更新するデータオブジェクト
 * @returns {Promise<boolean>} - 保存が成功した場合は true、失敗した場合は false
 */
async function saveChannelRewardDataToFirestore(channelId, rewardDataToSave) {
    const docRef = getChannelRewardDocRef(channelId);
    if (!docRef) {
        console.warn(`Cannot save channel reward data for ${channelId}. Firestore reference not available or invalid channelId.`);
        return false; // docRefがnullの場合は失敗を返す
    }
    try {
        await setDoc(docRef, rewardDataToSave, { merge: true });
        channelChatRewards.set(channelId, rewardDataToSave); // キャッシュも更新
        return true; // 成功を返す
    } catch (error) {
        console.error(`Error saving channel reward data for ${channelId}:`, error);
        return false; // エラーが発生した場合は失敗を返す
    }
}


/**
 * Firestoreから全てのユーザーデータ、会社データ、株データ、チャンネル報酬データを同期し、キャッシュを更新します。
 * 存在しない会社IDを持つユーザーのデータをクリーンアップします。
 * @returns {object} - 同期されたデータ数を返します。
 */
async function syncAllDataFromFirestore() {
    console.log("Syncing all data from Firestore...");
    if (!db || firebaseAuthUid === 'anonymous') {
        console.warn('Firestore instance or authenticated UID is not ready. Cannot sync all data.');
        return { users: 0, companies: 0, stocks: 0, channelRewards: 0 };
    }

    // まずキャッシュをクリア
    userDataCache.clear();
    companyDataCache.clear();
    stockDataCache.clear();
    channelChatRewards.clear(); // チャンネル報酬キャッシュもクリア

    let loadedUsersCount = 0;
    let loadedCompaniesCount = 0;
    let loadedStocksCount = 0;
    let loadedChannelRewardsCount = 0;

    try {
        // 全ての会社データを読み込み
        const companiesCollectionRef = collection(db, `artifacts/${appId}/public/data/companies`);
        const companiesQuerySnapshot = await getDocs(companiesCollectionRef);
        companiesQuerySnapshot.forEach(docSnap => {
            const companyId = docSnap.id;
            const data = docSnap.data();
            for (const key in defaultCompanyData) {
                if (data[key] === undefined) {
                    data[key] = defaultCompanyData[key];
                }
            }
            // パスワードフィールドがなければnullで初期化
            if (data.password === undefined) {
                data.password = null;
            }
            companyDataCache.set(companyId, data);
            loadedCompaniesCount++;
        });
        console.log(`Successfully loaded ${loadedCompaniesCount} company data entries from Firestore.`);

        // 全ての株データを読み込み
        const stocksCollectionRef = collection(db, `artifacts/${appId}/public/data/company_stocks`);
        const stocksQuerySnapshot = await getDocs(stocksCollectionRef);
        stocksQuerySnapshot.forEach(docSnap => {
            const companyId = docSnap.id;
            const data = docSnap.data();
            for (const key in defaultStockData) {
                if (data[key] === undefined) {
                    data[key] = defaultStockData[key];
                }
            }
            stockDataCache.set(companyId, data);
            loadedStocksCount++;
        });
        console.log(`Successfully loaded ${loadedStocksCount} stock data entries from Firestore.`);

        // 全てのチャンネル報酬データを読み込み
        const channelRewardsCollectionRef = collection(db, `artifacts/${appId}/public/data/channel_rewards`);
        const channelRewardsQuerySnapshot = await getDocs(channelRewardsCollectionRef);
        channelRewardsQuerySnapshot.forEach(docSnap => {
            const channelId = docSnap.id;
            const data = docSnap.data();
            for (const key in defaultChannelRewardData) {
                if (data[key] === undefined) {
                    data[key] = defaultChannelRewardData[key];
                }
            }
            channelChatRewards.set(channelId, data);
            loadedChannelRewardsCount++;
        });
        console.log(`Successfully loaded ${loadedChannelRewardsCount} channel reward data entries from Firestore.`);


        // 全てのユーザーデータを読み込み
        const usersCollectionRef = collection(db, `artifacts/${appId}/public/data/discord_incoin_data`);
        const usersQuerySnapshot = await getDocs(usersCollectionRef);
        for (const docSnap of usersQuerySnapshot.docs) {
            const userId = docSnap.id;
            const data = docSnap.data();
            for (const key in defaultUserData) {
                if (data[key] === undefined) {
                    data[key] = defaultUserData[key];
                }
            }
            
            // 存在しないcompanyIdのクリーンアップ
            if (data.companyId && !companyDataCache.has(data.companyId)) {
                console.warn(`User ${userId} has companyId ${data.companyId} but company does not exist. Cleaning up.`);
                data.companyId = null;
                data.job = '無職'; // 会社がないので無職に戻す
                await saveUserDataToFirestore(userId, data); // Firestoreも更新
            }

            // 存在しない会社の株をユーザーの保有株から削除
            const userStocks = data.stocks || {};
            let stocksChanged = false;
            for (const companyId in userStocks) {
                if (!companyDataCache.has(companyId)) {
                    console.warn(`User ${userId} owns stock for deleted company ${companyId}. Removing from user data.`);
                    delete userStocks[companyId];
                    stocksChanged = true;
                }
            }
            if (stocksChanged) {
                data.stocks = userStocks;
                await saveUserDataToFirestore(userId, data); // Firestoreも更新
            }

            userDataCache.set(userId, data);
            loadedUsersCount++;
        }
        console.log(`Successfully loaded and cleaned up ${loadedUsersCount} user data entries from Firestore.`);

        return { users: loadedUsersCount, companies: loadedCompaniesCount, stocks: loadedStocksCount, channelRewards: loadedChannelRewardsCount };
    } catch (error) {
        console.error("Error syncing all data from Firestore:", error);
        return { users: 0, companies: 0, stocks: 0, channelRewards: 0 };
    }
}

// === Stock Price Fluctuation ===
const STOCK_UPDATE_INTERVAL_MS = 10 * 60 * 1000; // 10分
const STOCK_PRICE_MIN = 650;
const STOCK_PRICE_MAX = 1500;
const STOCK_PRICE_CHANGE_MAX = 100; // 10分ごとの最大変動幅

async function applyStockPriceUpdates() {
    console.log("Applying stock price updates...");
    const companies = await getAllCompanies(); // 現在存在する会社を全て取得

    for (const company of companies) {
        const companyId = company.id;
        let stockData = await getStockData(companyId);

        const now = Date.now();
        let newPrice;

        if (stockData.lastUpdateTime === 0 || !stockData.currentPrice) {
            // 初回またはデータがない場合、初期価格を設定
            newPrice = Math.floor(Math.random() * (STOCK_PRICE_MAX - STOCK_PRICE_MIN + 1)) + STOCK_PRICE_MIN;
        } else {
            // 現在の価格からランダムに変動
            const currentPrice = stockData.currentPrice;
            const change = Math.floor(Math.random() * (STOCK_PRICE_CHANGE_MAX * 2 + 1)) - STOCK_PRICE_CHANGE_MAX; // -100から+100
            newPrice = currentPrice + change;

            // 最小値と最大値にクランプ
            newPrice = Math.max(STOCK_PRICE_MIN, Math.min(STOCK_PRICE_MAX, newPrice));
        }

        // 価格履歴を更新 (過去1時間分、つまり6点 (10分ごと) を保持)
        const updatedPriceHistory = [...stockData.priceHistory, { timestamp: now, price: newPrice }]
                                    .filter(entry => now - entry.timestamp < 60 * 60 * 1000); // 1時間以内のデータのみ保持
        
        // 常に最新の6件を保持するために、配列のサイズを制限
        while (updatedPriceHistory.length > 6) {
            updatedPriceHistory.shift();
        }

        stockData.currentPrice = newPrice;
        stockData.priceHistory = updatedPriceHistory;
        stockData.lastUpdateTime = now;
        stockData.companyId = companyId; // companyIdも保存

        await saveStockDataToFirestore(companyId, stockData);
        console.log(`Updated stock price for ${company.name} (${companyId}): ${newPrice.toLocaleString()} いんコイン`);
    }
    // 会社が削除されたが、株データが残っている場合のクリーンアップ
    const allStocks = await getAllStocks();
    for (const stock of allStocks) {
        if (!companies.some(c => c.id === stock.companyId)) {
            console.warn(`Stock data found for non-existent company ${stock.companyId}. Deleting stock data.`);
            await deleteStockFromFirestore(stock.companyId);
        }
    }
}


// 会社メンバーへの日給支払い処理と維持費の引き落とし
async function applyDailyCompanyPayouts() {
    console.log("Applying daily company payouts...");
    const companies = await getAllCompanies(); // 最新の会社データを取得

    for (const company of companies) {
        const now = Date.now();
        const ONE_DAY_MS = 24 * 60 * 60 * 1000; // 1日

        // 最終支払い時刻が設定されていない、または1日以上経過している場合
        if (now - company.lastPayoutTime >= ONE_DAY_MS) {
            const dailySalary = company.dailySalary;
            const members = company.members || [];
            const ownerId = company.ownerId;
            const companyName = company.name;

            // 維持費を計算: 日給 × 人数 + 300,000
            const maintenanceFee = (dailySalary * members.length) + 300000;
            const totalPayoutNeeded = (dailySalary * members.length); // 純粋な日給の合計

            console.log(`Company ${companyName} (${company.id}): Daily salary: ${dailySalary}, Members: ${members.length}, Maintenance Fee: ${maintenanceFee}, Current Budget: ${company.budget}`);

            if (company.budget < maintenanceFee + totalPayoutNeeded) { // 維持費と日給支払いの両方で足りない場合
                console.warn(`Company ${companyName} (${company.id}) budget (${company.budget}) is insufficient for maintenance fee (${maintenanceFee}) and payout (${totalPayoutNeeded}). Deleting company.`);

                // 社長に予算不足と会社削除をDM通知
                const owner = await client.users.fetch(ownerId).catch(() => null);
                if (owner) {
                    const embed = new EmbedBuilder()
                        .setTitle('会社削除通知: 予算不足')
                        .setColor('#FF0000')
                        .setDescription(`あなたの会社「${companyName}」は、維持費と日給支払いに必要な予算が不足しているため、削除されました。
必要な維持費: ${maintenanceFee.toLocaleString()} いんコイン
必要な日給合計: ${totalPayoutNeeded.toLocaleString()} いんコイン
現在の予算: ${company.budget.toLocaleString()} いんコイン

社員は自動的に会社から脱退し、「無職」に戻りました。`)
                        .setTimestamp();
                    try {
                        await owner.send({ embeds: [embed] });
                    } catch (dmError) {
                        console.error(`Failed to send company deletion DM to owner ${ownerId}:`, dmError);
                    }
                }

                // 全メンバーのcompanyIdをnullにリセットし、職業を「無職」に戻す
                for (const member of members) {
                    await updateUserDataField(member.id, 'companyId', null);
                    await setUserJob(member.id, "無職"); // 社長も含め全員無職に戻す
                    // メンバーにも会社が解散したことをDMで通知
                    const memberUser = await client.users.fetch(member.id).catch(() => null);
                    if (memberUser && member.id !== ownerId) { // 社長には既にDM済みのため重複を避ける
                        const memberEmbed = new EmbedBuilder()
                            .setTitle('会社解散通知')
                            .setColor('#FF0000')
                            .setDescription(`あなたが所属していた会社「${companyName}」は、予算不足のため解散しました。
あなたの職業は「無職」に戻りました。`)
                            .setTimestamp();
                        try {
                            await memberUser.send({ embeds: [memberEmbed] });
                        } catch (dmError) {
                            console.error(`Failed to send dissolution DM to member ${member.id}:`, dmError);
                        }
                    }
                }
                await deleteCompanyFromFirestore(company.id); // 会社データを削除
                console.log(`Company ${companyName} (${company.id}) was deleted due to insufficient budget.`);
                continue; // 次の会社へ
            }

            // 予算から維持費を差し引く
            await updateCompanyDataField(company.id, 'budget', company.budget - maintenanceFee);
            console.log(`Company ${companyName} (${company.id}): Deducted maintenance fee ${maintenanceFee}. New budget: ${company.budget - maintenanceFee}`);

            // 各メンバーに日給を付与
            for (const member of members) {
                await addCoins(member.id, dailySalary);
                // メンバーに日給支払いをDM通知
                const memberUser = await client.users.fetch(member.id).catch(() => null);
                if (memberUser) {
                    const embed = new EmbedBuilder()
                        .setTitle('日給支払い通知')
                        .setColor('#00FF00')
                        .setDescription(`会社「${companyName}」から日給として **${dailySalary.toLocaleString()}** いんコインが支払われました。
現在の所持金: ${(await getUserData(member.id)).balances.toLocaleString()} いんコイン`)
                        .setTimestamp();
                    try {
                        await memberUser.send({ embeds: [embed] });
                    } catch (dmError) {
                        console.error(`Failed to send daily salary DM to member ${member.id}:`, dmError);
                    }
                }
            }
            console.log(`Company ${companyName} (${company.id}) paid ${totalPayoutNeeded} to its members.`);
            await saveCompanyDataToFirestore(company.id, { ...company, lastPayoutTime: now }); // 成功しても失敗しても時間を更新
        }
    }
}


// 毎日午後9時に実行されるように設定 (JST)
setInterval(async () => {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // 日本時間の午後9時 (21時00分) に実行 - 会社支払い
    if (currentHour === 21 && currentMinute === 0) {
        if (client.isReady() && GUILD_ID && db && firebaseAuthUid !== 'anonymous') {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (guild) {
                console.log('Applying daily company payouts...');
                await applyDailyCompanyPayouts();
            }
        }
    }
    // 毎週の更新もここで定期実行 (木曜日の午後9時)
    if (currentHour === 21 && currentMinute === 0 && now.getDay() === 4) { // 木曜日の午後9時 (0=日, 1=月, ..., 4=木)
        if (client.isReady() && GUILD_ID && db && firebaseAuthUid !== 'anonymous') {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (guild) {
                console.log('Applying weekly updates...');
                await applyWeeklyUpdates(guild);
            }
        }
    }
}, 60 * 1000); // 1分ごとにチェック

// 株価更新を10分ごとに実行
setInterval(async () => {
    if (client.isReady() && db && firebaseAuthUid !== 'anonymous') {
        await applyStockPriceUpdates();
    }
}, STOCK_UPDATE_INTERVAL_MS);


async function applyWeeklyUpdates(guild) {
    if (!db || firebaseAuthUid === 'anonymous') {
        console.warn('Firestore instance or authenticated UID is not ready for weekly updates. Skipping.');
        return;
    }
    const usersCollectionRef = collection(db, `artifacts/${appId}/public/data/discord_incoin_data`);
    try {
        const querySnapshot = await getDocs(usersCollectionRef);
        for (const docSnapshot of querySnapshot.docs) {
            const userId = docSnapshot.id;
            const userData = docSnapshot.data();
            
            // 欠けているデフォルトフィールドを補完
            for (const key in defaultUserData) {
                if (userData[key] === undefined) {
                    userData[key] = defaultUserData[key];
                }
            }
            userDataCache.set(userId, userData); // キャッシュを最新の状態に保つ

            if (userData.isRegistered) {
                const lastInterestTime = userData.lastInterestTime || 0;
                const now = Date.now();
                const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
                if (now - lastInterestTime >= ONE_WEEK_MS) {
                    const creditPoints = userData.creditPoints;
                    let bankCoins = userData.bankBalances;
                    let updated = false;
                    if (creditPoints < 0) {
                        const deductionAmount = Math.floor(bankCoins * 0.10);
                        if (deductionAmount > 0) {
                            await addBankCoins(userId, -deductionAmount);
                            console.log(`User ${userId}: Deducted ${deductionAmount} (10%) from bank due to negative credit. New bank balance: ${await getBankCoins(userId)}`);
                            updated = true;
                        }
                        await addCreditPoints(userId, -1);
                        console.log(`User ${userId}: Credit points decreased to ${await getCreditPoints(userId)} due to negative credit.`);
                        updated = true;
                    } else {
                        const interestAmount = Math.floor(bankCoins * 0.03);
                        if (interestAmount > 0) {
                            await addBankCoins(userId, interestAmount);
                            console.log(`User ${userId}: Applied ${interestAmount} interest. New bank balance: ${await getBankCoins(userId)}`);
                            updated = true;
                        }
                    }
                    if (updated) {
                        await setUserLastInterestTime(userId, now);
                    }
                }
            }
        }
    } catch (error) {
        console.error("Error applying weekly updates from Firestore:", error);
    }
}

// === Discord Commands ===

const registerCommand = {
    data: new SlashCommandBuilder()
        .setName('register')
        .setDescription('いんコインシステムに登録します。登録しないとデータは保存されません。'),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const userData = await getUserData(userId);

        if (userData.isRegistered) {
            return interaction.editReply({ content: 'あなたは既にいんコインシステムに登録済みです。' });
        }

        const docRef = getUserDocRef(userId);
        if (!docRef) {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        try {
            const dataToSave = { ...userData, isRegistered: true, username: interaction.user.username }; 
            await setDoc(docRef, dataToSave);
            userDataCache.set(userId, dataToSave);

            await interaction.editReply({ content: 'いんコインシステムへの登録が完了しました！これであなたのデータは自動的に保存されます。' });
        } catch (error) {
            console.error(`Error registering user ${userId}:`, error);
            await interaction.editReply({ content: '登録中にエラーが発生しました。もう一度お試しください。' });
        }
    },
};
client.commands.set(registerCommand.data.name, registerCommand);


const gamblingCommand = {
    data: new SlashCommandBuilder()
        .setName('gambling')
        .setDescription('いんコインを賭けてギャンブルをします。')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('賭けるいんコインの金額')
                .setRequired(true)
                .setMinValue(1)),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const creditPoints = await getCreditPoints(userId);

        if (creditPoints < 0) {
            return interaction.editReply({ content: '信用ポイントが負のため、ギャンブルはできません。' });
        }

        const betAmount = interaction.options.getInteger('amount');

        const currentCoins = await getCoins(userId);

        if (currentCoins < betAmount) {
            return interaction.editReply({ content: `いんコインが足りません！現在 ${currentCoins.toLocaleString()} いんコイン持っています。` });
        }
        if (betAmount === 0) {
            return interaction.editReply({ content: '賭け金が0いんコインではギャンブルできません。' });
        }

        await addCoins(userId, -betAmount);

        const multiplier = Math.random() * 2.35 + 0.005;
        let winAmount = Math.floor(betAmount * multiplier);
        
        // Youtuberと社長の仕事はギャンブルには影響しないため、このブロックは不要。
        // 以前のコードではコメントアウトされていたため、引き続き影響なし。

        const newCoins = await addCoins(userId, winAmount);

        const embed = new EmbedBuilder()
            .setTitle('いんコインギャンブル結果')
            .addFields(
                { name: '賭け金', value: `${betAmount.toLocaleString()} いんコイン`, inline: true },
                { name: '倍率', value: `${multiplier.toFixed(2)} 倍`, inline: true },
                { name: '獲得/損失', value: `${(winAmount - betAmount).toLocaleString()} いんコイン`, inline: true },
                { name: '現在の残高', value: `${newCoins.toLocaleString()} いんコイン`, inline: false }
            )
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        if (multiplier > 1.0) {
            embed.setDescription(`あたり！ ${betAmount.toLocaleString()} いんコインが ${multiplier.toFixed(2)} 倍になり、${winAmount.toLocaleString()} いんコインを獲得しました！`)
                 .setColor('#00FF00');
        } else {
            embed.setDescription(`はずれ... ${betAmount.toLocaleString()} いんコインが ${multiplier.toFixed(2)} 倍になり、${winAmount.toLocaleString()} いんコインになりました。`)
                 .setColor('#FF0000');
            await addCreditPoints(userId, -1);
        }

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(gamblingCommand.data.name, gamblingCommand);

const moneyCommand = {
    data: new SlashCommandBuilder()
        .setName('money')
        .setDescription('いんコイン関連のコマンドです。')
        .addSubcommand(subcommand =>
            subcommand
                .setName('help')
                .setDescription('いんコイン関連のコマンドヘルプを表示します。'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('balance')
                .setDescription('自分または他のユーザーの所持金を表示します。')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('残高を確認したいユーザー')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('info')
                .setDescription('自分の現在の残高、銀行残高、信用ポイントを表示します。')),
    default_member_permissions: null,
    async execute(interaction) {
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'help') {
            const helpEmbed = new EmbedBuilder()
                .setTitle('いんコインコマンドヘルプ')
                .setDescription('利用可能なコマンドとその説明です。')
                .setColor('ADFF2F')
                .addFields(
                    { name: '/money balance [user]', value: '自分または他のユーザーの所持金を表示します。', inline: false },
                    { name: '/money info', value: '自分の所持金、銀行残高、信用ポイントを表示します。', inline: false },
                    { name: '/deposit <amount>', value: '所持金を銀行に預けます。', inline: false },
                    { name: '/withdraw <amount>', value: '銀行から所持金を引き出します。', inline: false },
                    { name: '/work', value: '2時間に1回、いんコインを稼ぎます。信用ポイントが1増えます。', inline: false },
                    { name: '/rob <target>', value: '他のユーザーの所持金を盗みます。成功すると信用ポイントが5減り、失敗すると3減ります。', inline: false },
                    { name: '/gambling <amount>', value: 'いんコインを賭けてギャンブルをします。負けると信用ポイントが1減ります。', inline: false },
                    { name: '/give-money <amount> <user|role>', value: '他のユーザーまたはロールのメンバーにいんコインを渡します。', inline: false },
                    { name: '/company help', value: '会社関連のコマンドヘルプを表示します。', inline: false },
                    { name: '/stock help', value: '株関連のコマンドヘルプを表示します。', inline: false }, // 新しい株コマンドのヘルプ
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [helpEmbed] });
        } else if (subcommand === 'balance') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const targetUserId = targetUser.id;
            const targetUserCoins = await getCoins(targetUserId);

            const embed = new EmbedBuilder()
                .setTitle('いんコイン残高')
                .setColor('#FFFF00')
                .setDescription(`${targetUser.username} さんの現在のいんコイン残高は **${targetUserCoins.toLocaleString()} いんコイン** です。`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'info') {
            const userId = interaction.user.id;
            const currentCoins = await getCoins(userId);
            const bankCoins = await getBankCoins(userId);
            const creditPoints = await getCreditPoints(userId);

            const embed = new EmbedBuilder()
                .setTitle(`${interaction.user.username} さんの情報`)
                .setColor('#ADD8E6')
                .addFields(
                    { name: '現在の所持金', value: `${currentCoins.toLocaleString()} いんコイン`, inline: false },
                    { name: '現在の銀行残高', value: `${bankCoins.toLocaleString()} いんコイン`, inline: false },
                    { name: '信用ポイント', value: `${creditPoints}`, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            await interaction.editReply({ embeds: [embed] });
        }
    },
};
client.commands.set(moneyCommand.data.name, moneyCommand);


const WORK_COOLDOWN_MS = 2 * 60 * 60 * 1000;

const workCommand = {
    data: new SlashCommandBuilder()
        .setName('work')
        .setDescription('2時間に1回、いんコインを稼ぎます。'),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const now = Date.now();
        const lastWork = await getUserLastWorkTime(userId);

        if (now - lastWork < WORK_COOLDOWN_MS) {
            const timeLeft = WORK_COOLDOWN_MS - (now - lastWork);
            const minutesLeft = Math.ceil(timeLeft / (1000 * 60));
            return interaction.editReply({ content: `まだ仕事できません。あと ${minutesLeft} 分待ってください。` });
        }

        let earnedAmount;
        const userJob = await getUserJob(userId) || "無職";
        const userData = await getUserData(userId);
        const creditPoints = userData.creditPoints;

        if (userJob && jobSettings.has(userJob)) {
            const jobEarn = jobSettings.get(userJob);
            if (userJob === "Youtuber") {
                if (creditPoints > 0) {
                    const { minMultiplier, maxMultiplier } = jobSettings.get("Youtuber");
                    const randomMultiplier = Math.floor(Math.random() * (maxMultiplier - minMultiplier + 1)) + minMultiplier;
                    earnedAmount = creditPoints * randomMultiplier;
                } else {
                    earnedAmount = Math.floor(Math.random() * (100 - 10 + 1)) + 10;
                }
            } else if (userJob === "社長") {
                const companyId = userData.companyId;
                if (companyId) {
                    const companyData = await getCompanyData(companyId);
                    if (companyData && companyData.ownerId === userId) {
                        const numMembers = companyData.members.length;
                        const { minBase, maxBase, memberBonus } = jobSettings.get("社長");
                        earnedAmount = Math.floor(Math.random() * (maxBase - minBase + 1)) + minBase + (numMembers * memberBonus);
                    } else {
                        earnedAmount = Math.floor(Math.random() * (1500 - 1000 + 1)) + 1000;
                    }
                } else {
                    earnedAmount = Math.floor(Math.random() * (1500 - 1000 + 1)) + 1000;
                }
            } else {
                earnedAmount = Math.floor(Math.random() * (jobEarn.max - jobEarn.min + 1)) + jobEarn.min;
            }
        } else {
            earnedAmount = Math.floor(Math.random() * (1500 - 1000 + 1)) + 1000;
        }
        
        const userCompanyId = userData.companyId;
        if (userCompanyId) {
            const companyData = await getCompanyData(userCompanyId);
            if (companyData && companyData.autoDeposit) {
                await updateCompanyDataField(userCompanyId, 'budget', companyData.budget + earnedAmount);
                const embed = new EmbedBuilder()
                    .setTitle('お仕事結果')
                    .setColor('#00FF00')
                    .setDescription(`お疲れ様です！ ${earnedAmount.toLocaleString()} いんコインを獲得しました。\nこの金額は、自動で会社「${companyData.name}」の予算に入金されました。`)
                    .addFields(
                        { name: 'あなたの所持金', value: `${(await getCoins(userId)).toLocaleString()} いんコイン`, inline: false },
                        { name: '会社の予算', value: `${(await getCompanyData(userCompanyId)).budget.toLocaleString()} いんコイン`, inline: false },
                        { name: '信用ポイント', value: `${await getCreditPoints(userId)}`, inline: false }
                    )
                    .setTimestamp()
                    .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
                await interaction.editReply({ embeds: [embed] });
                await addCreditPoints(userId, 1);
                await setUserLastWorkTime(userId, now);
                return;
            }
        }

        const newCoins = await addCoins(userId, earnedAmount);
        await addCreditPoints(userId, 1);

        await setUserLastWorkTime(userId, now);

        const embed = new EmbedBuilder()
            .setTitle('お仕事結果')
            .setColor('#00FF00')
            .setDescription(`お疲れ様です！ ${earnedAmount.toLocaleString()} いんコインを獲得しました。`)
            .addFields(
                { name: '現在の残高', value: `${newCoins.toLocaleString()} いんコイン`, inline: false },
                { name: '信用ポイント', value: `${await getCreditPoints(userId)}`, inline: false }
            )
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(workCommand.data.name, workCommand);

const ROB_COOLDOWN_MS = 3 * 60 * 60 * 1000;

const robCommand = {
    data: new SlashCommandBuilder()
        .setName('rob')
        .setDescription('他のユーザーからいんコインを盗みます。')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('盗む相手のユーザー')
                .setRequired(true)),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const robberUser = interaction.user;
        const creditPoints = await getCreditPoints(robberUser.id);

        if (creditPoints < 0) {
            return interaction.editReply({ content: '信用ポイントが負のため、強盗はできません。' });
        }

        const targetUser = interaction.options.getUser('target');
        const now = Date.now();
        const lastRob = await getUserLastRobTime(robberUser.id);

        if (now - lastRob < ROB_COOLDOWN_MS) {
            const timeLeft = ROB_COOLDOWN_MS - (now - lastRob);
            const hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
            const minutesLeft = Math.ceil((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
            return interaction.editReply({ content: `まだ強盗できません。あと ${hoursLeft} 時間 ${minutesLeft} 分待ってください。` });
        }

        if (robberUser.id === targetUser.id) {
            return interaction.editReply({ content: '自分自身を盗むことはできません！' });
        }

        if (targetUser.bot) {
            return interaction.editReply({ content: 'ボットからいんコインを盗むことはできません！' });
        }

        const targetCoins = await getCoins(targetUser.id);
        const robberCoins = await getCoins(robberUser.id);

        if (targetCoins <= 0) {
            return interaction.editReply({ content: `${targetUser.username} さんは現在いんコインを持っていません。` });
        }

        const successChance = 0.65;
        const isSuccess = Math.random() < successChance;

        let embed = new EmbedBuilder()
            .setTitle('強盗結果')
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await setUserLastRobTime(robberUser.id, now);

        if (isSuccess) {
            const stolenPercentage = Math.random() * (0.65 - 0.50) + 0.50;
            const stolenAmount = Math.floor(targetCoins * stolenPercentage);

            await addCoins(targetUser.id, -stolenAmount);
            await addCoins(robberUser.id, stolenAmount);
            await addCreditPoints(robberUser.id, -5);

            embed.setDescription(`強盗成功！ ${targetUser.username} さんから **${stolenAmount.toLocaleString()}** いんコインを盗みました！`)
                 .addFields(
                     { name: `${robberUser.username} の現在の残高`, value: `${(await getCoins(robberUser.id)).toLocaleString()} いんコイン`, inline: true },
                     { name: `${targetUser.username} の現在の残高`, value: `${(await getCoins(targetUser.id)).toLocaleString()} いんコイン`, inline: true },
                     { name: 'あなたの信用ポイント', value: `${await getCreditPoints(robberUser.id)}`, inline: false }
                 )
                 .setColor('#00FF00');
        } else {
            const penaltyPercentage = Math.random() * (0.45 - 0.30) + 0.30;
            const penaltyAmount = Math.floor(robberCoins * penaltyPercentage);
            const newRobberCoins = await addCoins(robberUser.id, -penaltyAmount);
            await addCreditPoints(robberUser.id, -3);

            embed.setDescription(`強盗失敗... ${targetUser.username} さんからいんコインを盗むことができませんでした。
罰金として **${penaltyAmount.toLocaleString()}** いんコインを失いました。`)
                 .addFields(
                     { name: `${robberUser.username} の現在の残高`, value: `${newRobberCoins.toLocaleString()} いんコイン`, inline: false },
                     { name: 'あなたの信用ポイント', value: `${await getCreditPoints(robberUser.id)}`, inline: false }
                 )
                 .setColor('#FF0000');
        }

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(robCommand.data.name, robCommand);

const depositCommand = {
    data: new SlashCommandBuilder()
        .setName('deposit')
        .setDescription('所持金を銀行に預けます。')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('預ける金額')
                .setRequired(true)
                .setMinValue(1)),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const amount = interaction.options.getInteger('amount');
        const currentCoins = await getCoins(userId);

        if (currentCoins < amount) {
            return interaction.editReply({ content: `所持金が足りません！現在 ${currentCoins.toLocaleString()} いんコイン持っています。` });
        }

        await addCoins(userId, -amount);
        await addBankCoins(userId, amount);

        const embed = new EmbedBuilder()
            .setTitle('預金完了')
            .setColor('#00FF00')
            .setDescription(`${amount.toLocaleString()} いんコインを銀行に預けました。`)
            .addFields(
                { name: '現在の所持金', value: `${(await getCoins(userId)).toLocaleString()} いんコイン`, inline: true },
                { name: '現在の銀行残高', value: `${(await getBankCoins(userId)).toLocaleString()} いんコイン`, inline: true }
            )
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(depositCommand.data.name, depositCommand);

const withdrawCommand = {
    data: new SlashCommandBuilder()
        .setName('withdraw')
        .setDescription('銀行からお金を引き出します。')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('引き出す金額')
                .setRequired(true)
                .setMinValue(1)),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const amount = interaction.options.getInteger('amount');
        const currentBankCoins = await getBankCoins(userId);

        if (currentBankCoins < amount) {
            return interaction.editReply({ content: `銀行残高が足りません！現在 ${currentBankCoins.toLocaleString()} いんコインが銀行にあります。` });
        }

        await addBankCoins(userId, -amount);
        await addCoins(userId, amount);

        const embed = new EmbedBuilder()
            .setTitle('引き出し完了')
            .setColor('#00FF00')
            .setDescription(`${amount.toLocaleString()} いんコインを銀行から引き出しました。`)
            .addFields(
                { name: '現在の所持金', value: `${(await getCoins(userId)).toLocaleString()} いんコイン`, inline: true },
                { name: '現在の銀行残高', value: `${(await getBankCoins(userId)).toLocaleString()} いんコイン`, inline: true }
            )
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(withdrawCommand.data.name, withdrawCommand);

const addMoneyCommand = {
    data: new SlashCommandBuilder()
        .setName('add-money')
        .setDescription('指定したユーザーまたはロールにいんコインを追加します。(管理者のみ)')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('追加するいんコインの金額')
                .setRequired(true)
                .setMinValue(1))
        .addUserOption(option =>
            option.setName('user')
                .setDescription('いんコインを追加するユーザー')
                .setRequired(false))
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('いんコインを追加するロールのメンバー')
                .setRequired(false)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    async execute(interaction) {
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }

        const amount = interaction.options.getInteger('amount');
        const targetUser = interaction.options.getUser('user');
        const targetRole = interaction.options.getRole('role');

        if (!targetUser && !targetRole) {
            return interaction.editReply({ content: 'ユーザーまたはロールのどちらかを指定してください。' });
        }

        let replyMessage = '';
        if (targetUser) {
            const newCoins = await addCoins(targetUser.id, amount);
            replyMessage = `${targetUser.username} に ${amount.toLocaleString()} いんコインを追加しました。\n現在の残高: ${newCoins.toLocaleString()} いんコイン`;
        } else if (targetRole) {
            await interaction.guild.members.fetch();
            const members = interaction.guild.members.cache.filter(member => member.roles.cache.has(targetRole.id) && !member.user.bot);
            let addedCount = 0;
            for (const member of members.values()) {
                await addCoins(member.id, amount);
                addedCount++;
            }
            replyMessage = `${targetRole.name} ロールの ${addedCount} 人のメンバーに ${amount.toLocaleString()} いんコインを追加しました。`;
        }

        const embed = new EmbedBuilder()
            .setTitle('いんコイン追加')
            .setColor('#00FF00')
            .setDescription(replyMessage)
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(addMoneyCommand.data.name, addMoneyCommand);

const removeMoneyCommand = {
    data: new SlashCommandBuilder()
        .setName('remove-money')
        .setDescription('指定したユーザーまたはロールからいんコインを削除します。(管理者のみ)')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('削除するいんコインの金額')
                .setRequired(true)
                .setMinValue(1))
        .addUserOption(option =>
            option.setName('user')
                .setDescription('いんコインを削除するユーザー')
                .setRequired(false))
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('いんコインを削除するロールのメンバー')
                .setRequired(false)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    async execute(interaction) {
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }

        const amount = interaction.options.getInteger('amount');
        const targetUser = interaction.options.getUser('user');
        const targetRole = interaction.options.getRole('role');

        if (!targetUser && !targetRole) {
            return interaction.editReply({ content: 'ユーザーまたはロールのどちらかを指定してください。' });
        }

        let replyMessage = '';
        if (targetUser) {
            const newCoins = await addCoins(targetUser.id, -amount);
            replyMessage = `${targetUser.username} から ${amount.toLocaleString()} いんコインを削除しました。\n現在の残高: ${newCoins.toLocaleString()} いんコイン`;
        } else if (targetRole) {
            await interaction.guild.members.fetch();
            const members = interaction.guild.members.cache.filter(member => member.roles.cache.has(targetRole.id) && !member.user.bot);
            let removedCount = 0;
            for (const member of members.values()) {
                await addCoins(member.id, -amount);
                removedCount++;
            }
            replyMessage = `${targetRole.name} ロールの ${removedCount} 人のメンバーからそれぞれ ${amount.toLocaleString()} いんコインを削除しました。`;
        }

        const embed = new EmbedBuilder()
            .setTitle('いんコイン削除')
            .setColor('#FF0000')
            .setDescription(replyMessage)
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(removeMoneyCommand.data.name, removeMoneyCommand);

const giveMoneyCommand = {
    data: new SlashCommandBuilder()
        .setName('give-money')
        .setDescription('他のユーザーまたはロールのメンバーにいんコインを渡します。')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('渡すいんコインの金額')
                .setRequired(true)
                .setMinValue(1))
        .addUserOption(option =>
            option.setName('user')
                .setDescription('いんコインを渡すユーザー')
                .setRequired(false))
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('いんコインを渡すロールのメンバー')
                .setRequired(false)),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const giverUser = interaction.user;
        const amount = interaction.options.getInteger('amount');
        const targetUser = interaction.options.getUser('user');
        const targetRole = interaction.options.getRole('role');

        if (!targetUser && !targetRole) {
            return interaction.editReply({ content: 'ユーザーまたはロールのどちらかを指定してください。' });
        }

        let affectedUsers = [];
        if (targetUser) {
            if (giverUser.id === targetUser.id) {
                return interaction.editReply({ content: '自分自身にいんコインを渡すことはできません！' });
            }
            if (targetUser.bot) {
                return interaction.editReply({ content: 'ボットにいんコインを渡すことはできません！' });
            }
            affectedUsers.push(targetUser);
        } else if (targetRole) {
            await interaction.guild.members.fetch();
            const members = interaction.guild.members.cache.filter(member =>
                member.roles.cache.has(targetRole.id) && !member.user.bot && member.user.id !== giverUser.id
            );
            affectedUsers = Array.from(members.values()).map(member => member.user);
        }

        if (affectedUsers.length === 0) {
            return interaction.editReply({ content: '指定されたユーザーまたはロールのメンバーが見つかりませんでした。' });
        }

        const totalCost = amount * affectedUsers.length;
        const giverCoins = await getCoins(giverUser.id);

        if (giverCoins < totalCost) {
            const embed = new EmbedBuilder()
                .setTitle('いんコイン送金失敗')
                .setColor('#FFD700')
                .setDescription(`いんコインが足りません！${affectedUsers.length}人へ${amount.toLocaleString()}いんコインを渡すには合計${totalCost.toLocaleString()}いんコインが必要です。\n現在の残高: ${giverCoins.toLocaleString()} いんコイン`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            return interaction.editReply({ embeds: [embed] });
        }

        await addCoins(giverUser.id, -totalCost);

        let replyMessage = '';
        if (targetUser) {
            await addCoins(targetUser.id, amount);
            replyMessage = `${targetUser.username} に ${amount.toLocaleString()} いんコインを渡しました。\n${giverUser.username} の現在の残高: ${(await getCoins(giverUser.id)).toLocaleString()} いんコイン\n${targetUser.username} の現在の残高: ${(await getCoins(targetUser.id)).toLocaleString()} いんコイン`;
        } else if (targetRole) {
            for (const user of affectedUsers) {
                await addCoins(user.id, amount);
            }
            replyMessage = `${targetRole.name} ロールの ${affectedUsers.length} 人のメンバーにそれぞれ ${amount.toLocaleString()} いんコインを渡しました。\n${giverUser.username} の現在の残高: ${(await getCoins(giverUser.id)).toLocaleString()} いんコイン`;
        }

        const embed = new EmbedBuilder()
            .setTitle('いんコイン送金完了')
            .setColor('#00FF00')
            .setDescription(replyMessage)
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(giveMoneyCommand.data.name, giveMoneyCommand);

const channelMoneyCommand = {
    data: new SlashCommandBuilder()
        .setName('channel-money')
        .setDescription('指定したチャンネルでのチャットに報酬を設定します。(管理者のみ)')
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('報酬を設定するチャンネル')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('min')
                .setDescription('チャットで獲得できる最低いんコイン')
                .setRequired(true)
                .setMinValue(0))
        .addIntegerOption(option =>
            option.setName('max')
                .setDescription('チャットで獲得できる最大いんコイン')
                .setRequired(true)
                .setMinValue(0)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    async execute(interaction) {
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }

        const channel = interaction.options.getChannel('channel');
        const minAmount = interaction.options.getInteger('min');
        const maxAmount = interaction.options.getInteger('max');

        if (minAmount > maxAmount) {
            return interaction.editReply({ content: '最低金額は最大金額以下である必要があります。' });
        }

        // Firestoreに保存するように変更し、成否をチェック
        const saveSuccess = await saveChannelRewardDataToFirestore(channel.id, { min: minAmount, max: maxAmount });

        if (!saveSuccess) {
            return interaction.editReply({ content: 'チャンネル報酬の設定中にデータベースエラーが発生しました。もう一度お試しください。', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setTitle('チャンネル報酬設定')
            .setColor('#00FF00')
            .setDescription(`${channel.name} でのチャット報酬を ${minAmount.toLocaleString()} いんコインから ${maxAmount.toLocaleString()} いんコインに設定しました。`)
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(channelMoneyCommand.data.name, channelMoneyCommand);

const jobsCommand = {
    data: new SlashCommandBuilder()
        .setName('jobs')
        .setDescription('職業関連のコマンドです。')
        .addSubcommand(subcommand =>
            subcommand
                .setName('assign')
                .setDescription('ユーザーに職業を割り当てます。(管理者のみ)')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('職業を割り当てるユーザー')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('job_name')
                        .setDescription('割り当てる職業名')
                        .setRequired(true)
                        .setAutocomplete(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('ユーザーから職業を削除します。(管理者のみ)')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('職業を削除するユーザー')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('設定されている職業の一覧を表示します。'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('my-job')
                .setDescription('自分の現在の職業を表示します。')),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const subcommand = interaction.options.getSubcommand();
        const userData = await getUserData(userId);
        const creditPoints = userData.creditPoints;

        if (subcommand === 'assign') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
            }
            const targetUser = interaction.options.getUser('user');
            const jobName = interaction.options.getString('job_name');
            if (jobName === "社長") {
                return interaction.editReply({ content: '「社長」は/company addコマンドで会社を作成した際に自動的に割り当てられます。手動で割り当てることはできません。' });
            }
            if (!jobSettings.has(jobName) && jobName !== "無職") {
                return interaction.editReply({ content: `職業 **${jobName}** は存在しません。設定済みの職業から選択してください。` });
            }

            await setUserJob(targetUser.id, jobName);
            await interaction.editReply({ content: `${targetUser.username} に職業 **${jobName}** を割り当てました。` });

        } else if (subcommand === 'remove') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
            }
            const targetUser = interaction.options.getUser('user');
            
            const targetUserData = await getUserData(targetUser.id);
            if (!targetUserData.job || targetUserData.job === "無職") {
                return interaction.editReply({ content: `${targetUser.username} には現在、職業が割り当てられていません。` });
            }
            if (targetUserData.job === "社長") {
                 return interaction.editReply({ content: '「社長」の職業を削除するには、先に会社を削除するか、他のユーザーに社長を引き継ぐ必要があります。' });
            }
            await setUserJob(targetUser.id, "無職");
            await interaction.editReply({ content: `${targetUser.username} から職業を削除し、「無職」に戻しました。` });

        } else if (subcommand === 'list') {
            if (jobSettings.size === 0) {
                return interaction.editReply({ content: '現在、設定されている職業はありません。' });
            }

            let description = '';
            for (const [jobName, settings] of jobSettings.entries()) {
                if (jobName === "Youtuber") {
                    description += `**${jobName}**: 信用ポイントに応じて変動 (信用が0より高い場合は 信用ポイント×${settings.minMultiplier.toLocaleString()} ～ 信用ポイント×${settings.maxMultiplier.toLocaleString()}、信用が0以下の場合は 10 ～ 100 いんコイン)\n`;
                } else if (jobName === "社長") {
                     description += `**${jobName}**: 会社メンバー数に応じて変動 (${settings.minBase.toLocaleString()} ～ ${settings.maxBase.toLocaleString()} + 会社人数×${settings.memberBonus.toLocaleString()} いんコイン)\n`;
                }
                else if (jobName === "無職") {
                    description += `**${jobName}**: ${settings.min.toLocaleString()} ～ ${settings.max.toLocaleString()} いんコイン (初期状態)\n`;
                }
                else {
                    description += `**${jobName}**: ${settings.min.toLocaleString()} ～ ${settings.max.toLocaleString()} いんコイン\n`;
                }
            }

            const embed = new EmbedBuilder()
                .setTitle('設定されている職業一覧')
                .setColor('#ADD8E6')
                .setDescription(description)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            await interaction.editReply({ embeds: [embed] });

        } else if (subcommand === 'my-job') {
            const currentJob = await getUserJob(userId) || "無職";
            let message;
            if (currentJob) {
                if (currentJob === "Youtuber") {
                    let predictionMessage;
                    if (creditPoints > 0) {
                        const { minMultiplier, maxMultiplier } = jobSettings.get("Youtuber");
                        const minPossible = creditPoints * minMultiplier;
                        const maxPossible = creditPoints * maxMultiplier;
                        predictionMessage = `(現在の信用ポイント ${creditPoints} の場合、約 ${minPossible.toLocaleString()} ～ ${maxPossible.toLocaleString()} いんコイン)`;
                    } else {
                        predictionMessage = `(現在の信用ポイント ${creditPoints} の場合、常に 10 ～ 100 いんコイン)`;
                    }
                    message = `あなたの現在の職業は **${currentJob}** です。\n/work で信用ポイントに応じていんコインを獲得できます。${predictionMessage}`;
                } else if (currentJob === "社長") {
                    const companyId = userData.companyId;
                    if (companyId) {
                        const companyData = await getCompanyData(companyId);
                        if (companyData && companyData.ownerId === userId) {
                            const numMembers = companyData.members.length;
                            const { minBase, maxBase, memberBonus } = jobSettings.get("社長");
                            const minEarned = minBase + (numMembers * memberBonus);
                            const maxEarned = maxBase + (numMembers * memberBonus);
                            message = `あなたの現在の職業は **${currentJob}** です。\n/work で約 ${minEarned.toLocaleString()} ～ ${maxEarned.toLocaleString()} いんコインを獲得できます。\n(現在の会社メンバー数: ${numMembers}人)`;
                        } else {
                             message = `あなたの現在の職業は **${currentJob}** ですが、所属している会社が見つからないか、あなたが社長ではありません。`;
                        }
                    } else {
                        message = `あなたの現在の職業は **${currentJob}** ですが、会社に所属していません。`;
                    }
                }
                else {
                    const jobEarn = jobSettings.get(currentJob);
                    message = `あなたの現在の職業は **${currentJob}** です。\n/work で ${jobEarn.min.toLocaleString()} ～ ${jobEarn.max.toLocaleString()} いんコインを獲得できます。`;
                }
            } else {
                message = '現在、あなたには職業が割り当てられていません。\n/work で 1000 ～ 1500 いんコインを獲得できます。';
            }
            await interaction.editReply({ content: message });
        }
    },
};
client.commands.set(jobsCommand.data.name, jobsCommand);

const jobChangeCommand = {
    data: new SlashCommandBuilder()
        .setName('job-change')
        .setDescription('職業を変更します。費用がかかります。')
        .addStringOption(option =>
            option.setName('job_name')
                .setDescription('変更したい職業名')
                .setRequired(true)
                .setAutocomplete(true)),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const requestedJob = interaction.options.getString('job_name');
        const currentJob = await getUserJob(userId) || "無職";

        if (currentJob === "社長") {
            return interaction.editReply({ content: 'あなたは会社の社長です。「社長」の職業を辞めるには、まず会社を削除するか、他のユーザーに社長を引き継ぐ必要があります。' });
        }
        if (!jobSettings.has(requestedJob) && requestedJob !== "無職") {
            return interaction.editReply({ content: `職業 **${requestedJob}** は存在しません。/jobs list で確認してください。` });
        }

        if (currentJob === requestedJob) {
            return interaction.editReply({ content: `あなたはすでに **${requestedJob}** です。` });
        }
        if (requestedJob === "社長") {
            return interaction.editReply({ content: '「社長」の職業は、/company addコマンドで会社を作成した際に自動的に割り当てられます。手動で転職することはできません。' });
        }

        const cost = jobChangeCosts.get(requestedJob);
        if (cost === undefined) {
            return interaction.editReply({ content: `職業 **${requestedJob}** の転職費用が設定されていません。` });
        }

        const currentCoins = await getCoins(userId);

        if (currentCoins < cost) {
            return interaction.editReply({ content: `転職費用が足りません！\n**${requestedJob}** への転職には **${cost.toLocaleString()}** いんコイン必要ですが、あなたは **${currentCoins.toLocaleString()}** いんコインしか持っていません。` });
        }

        await addCoins(userId, -cost);
        await setUserJob(userId, requestedJob);

        const embed = new EmbedBuilder()
            .setTitle('転職成功！')
            .setColor('#00FF00')
            .setDescription(`あなたは **${requestedJob}** に転職しました！\n費用として **${cost.toLocaleString()}** いんコインを支払いました。`)
            .addFields(
                { name: '現在の所持金', value: `${(await getCoins(userId)).toLocaleString()} いんコイン`, inline: false }
            )
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    }
};
client.commands.set(jobChangeCommand.data.name, jobChangeCommand);


const loadCommand = {
    data: new SlashCommandBuilder()
        .setName('load')
        .setDescription('最新のいんコイン情報を取得します。')
        .addUserOption(option => 
            option.setName('user')
                .setDescription('情報を取得したいユーザー')
                .setRequired(false))
        .addBooleanOption(option => 
            option.setName('all')
                .setDescription('全てのユーザーと会社のいんコイン情報を再取得します。(管理者のみ)')
                .setRequired(false)),
    default_member_permissions: null, 
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }

        const loadAll = interaction.options.getBoolean('all');
        const targetUser = interaction.options.getUser('user');

        if (loadAll) {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.editReply({ content: 'このコマンドで全てのユーザーと会社の情報を再取得するには管理者権限が必要です。' });
            }
            if (targetUser) {
                 return interaction.editReply({ content: '「全てのユーザー」と特定のユーザーを同時に指定することはできません。' });
            }

            const { users: loadedUsersCount, companies: loadedCompaniesCount, stocks: loadedStocksCount, channelRewards: loadedChannelRewardsCount } = await syncAllDataFromFirestore(); 
            const embed = new EmbedBuilder()
                .setTitle('いんコイン情報一括再取得')
                .setColor('#00FF00')
                .setDescription(`Firestoreから**${loadedUsersCount.toLocaleString()}人分**のユーザー情報、**${loadedCompaniesCount.toLocaleString()}件**の会社情報、**${loadedStocksCount.toLocaleString()}件**の株情報、**${loadedChannelRewardsCount.toLocaleString()}件**のチャンネル報酬情報を全て再取得し、キャッシュを更新しました。`) 
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });

        } else if (targetUser) { 
            const targetUserId = targetUser.id;
            const targetUserData = await getUserData(targetUserId); 

            if (!targetUserData.isRegistered) {
                return interaction.editReply({ content: `${targetUser.username} さんはいんコインシステムに登録されていません。` });
            }

            if (targetUserData.companyId && !companyDataCache.has(targetUserData.companyId)) {
                targetUserData.companyId = null;
                targetUserData.job = '無職';
                await saveUserDataToFirestore(targetUserId, targetUserData);
            }

            const embed = new EmbedBuilder()
                .setTitle(`${targetUser.username} さんのいんコイン情報`)
                .setColor('#00FF00')
                .addFields(
                    { name: '所持金', value: `${targetUserData.balances.toLocaleString()} いんコイン`, inline: false },
                    { name: '銀行残高', value: `${targetUserData.bankBalances.toLocaleString()} いんコイン`, inline: false },
                    { name: '信用ポイント', value: `${targetUserData.creditPoints}`, inline: false },
                    { name: '職業', value: `${targetUserData.job}`, inline: false },
                    { name: 'チャンネル登録者数', value: `${targetUserData.subscribers.toLocaleString()} 人`, inline: false },
                    { name: '所属会社', value: targetUserData.companyId ? (await getCompanyData(targetUserData.companyId))?.name || '不明' : 'なし', inline: false }
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });

        } else { 
            const currentUserData = await getUserData(userId); 

            if (!currentUserData.isRegistered) {
                return interaction.editReply({ content: 'あなたはいんコインシステムに登録されていません。`/register` コマンドで登録してください。' });
            }

            if (currentUserData.companyId && !companyDataCache.has(currentUserData.companyId)) {
                currentUserData.companyId = null;
                currentUserData.job = '無職';
                await saveUserDataToFirestore(userId, currentUserData);
            }
            
            const embed = new EmbedBuilder()
                .setTitle(`${interaction.user.username} さんのいんコイン情報`)
                .setColor('#00FF00')
                .addFields(
                    { name: '現在の所持金', value: `${currentUserData.balances.toLocaleString()} いんコイン`, inline: false },
                    { name: '現在の銀行残高', value: `${currentUserData.bankBalances.toLocaleString()} いんコイン`, inline: false },
                    { name: '信用ポイント', value: `${currentUserData.creditPoints}`, inline: false },
                    { name: '職業', value: `${currentUserData.job}`, inline: false },
                    { name: 'チャンネル登録者数', value: `${currentUserData.subscribers.toLocaleString()} 人`, inline: false },
                    { name: '所属会社', value: currentUserData.companyId ? (await getCompanyData(currentUserData.companyId))?.name || '不明' : 'なし', inline: false }
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        }
    },
};
client.commands.set(loadCommand.data.name, loadCommand);

const companyCommand = {
    data: new SlashCommandBuilder()
        .setName('company')
        .setDescription('会社関連のコマンドです。')
        .addSubcommand(subcommand =>
            subcommand
                .setName('help')
                .setDescription('会社関連のコマンドヘルプを表示します。'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('新しい会社を作成します。(社長のみ)')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('会社名')
                        .setRequired(true))
                .addIntegerOption(option =>
                    option.setName('daily_salary')
                        .setDescription('メンバーへの日給')
                        .setRequired(true)
                        .setMinValue(0))
                .addStringOption(option => // パスワードオプションを追加
                    option.setName('password')
                        .setDescription('会社参加用のパスワード (任意)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('edit') // 新しいeditコマンドを追加
                .setDescription('会社の情報（名前、パスワード）を変更します。(社長のみ)')
                .addStringOption(option =>
                    option.setName('new_name')
                        .setDescription('新しい会社名')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('new_password')
                        .setDescription('新しい会社パスワード')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('deposit')
                .setDescription('会社の予算に資金を預け入れます。')
                .addIntegerOption(option =>
                    option.setName('amount')
                        .setDescription('預け入れる金額')
                        .setRequired(true)
                        .setMinValue(1)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('withdraw')
                .setDescription('会社の予算から資金を引き出します。(社長のみ)')
                .addIntegerOption(option =>
                    option.setName('amount')
                        .setDescription('引き出す金額')
                        .setRequired(true)
                        .setMinValue(1)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('alldeposit')
                .setDescription('workコマンドの収益を自動で会社予算に入れるか設定します。(社長のみ)')
                .addBooleanOption(option =>
                    option.setName('toggle')
                        .setDescription('自動入金をONにするかOFFにするか')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('join')
                .setDescription('会社に参加します。')
                .addStringOption(option =>
                    option.setName('company_name')
                        .setDescription('参加したい会社名')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addStringOption(option => // パスワードオプションを追加
                    option.setName('password')
                        .setDescription('会社参加用のパスワード (必要な場合)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('info')
                .setDescription('自分または指定した会社の情報を表示します。')
                .addStringOption(option =>
                    option.setName('company_name')
                        .setDescription('情報を表示したい会社名 (未指定で自分の会社)')
                        .setRequired(false)
                        .setAutocomplete(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('自分の会社を削除します。(社長のみ)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('leave')
                .setDescription('所属している会社を辞めます。')),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'help') {
            const helpEmbed = new EmbedBuilder()
                .setTitle('会社コマンドヘルプ')
                .setDescription('会社関連の利用可能なコマンドとその説明です。')
                .setColor('ADD8E6')
                .addFields(
                    { name: '/company add <会社名> <日給> [パスワード]', value: '新しい会社を作成します。あなたが社長になります。(社長のみ)', inline: false },
                    { name: '/company edit [新しい会社名] [新しいパスワード]', value: '会社の情報（名前、パスワード）を変更します。(社長のみ)', inline: false },
                    { name: '/company deposit <金額>', value: 'あなたの所持金から会社予算に預け入れます。', inline: false },
                    { name: '/company withdraw <金額>', value: '会社の予算からあなたの所持金に引き出します。(社長のみ)', inline: false },
                    { name: '/company alldeposit <true|false>', value: 'workコマンドで得た収益を自動で会社予算に入れるか設定します。(社長のみ)', inline: false },
                    { name: '/company join <会社名> [パスワード]', value: '指定した会社に参加します。毎日日給が支払われます。', inline: false },
                    { name: '/company info [会社名]', value: '自分の所属する会社、または指定した会社の情報を表示します。', inline: false },
                    { name: '/company leave', value: '所属している会社を辞めます。(社長以外)', inline: false },
                    { name: '/company delete', value: 'あなたの会社を削除します。会社のいんコインは全て消滅します。(社長のみ)', inline: false },
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [helpEmbed] });
        } else if (subcommand === 'add') {
            const companyName = interaction.options.getString('name');
            const dailySalary = interaction.options.getInteger('daily_salary');
            const password = interaction.options.getString('password'); // パスワードオプションを取得

            const allCompanies = await getAllCompanies();
            const existingCompany = allCompanies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
            if (existingCompany) {
                return interaction.editReply({ content: 'その会社名は既に存在します。別の名前を試してください。' });
            }
            const userData = await getUserData(userId);
            if (userData.companyId) {
                const currentCompany = await getCompanyData(userData.companyId);
                return interaction.editReply({ content: `あなたは既に会社「${currentCompany.name}」に所属しています。新しい会社を作成する前に、現在の会社を抜けるか削除してください。` });
            }
            const companyId = crypto.randomUUID();
            const newCompanyData = {
                ...defaultCompanyData,
                name: companyName,
                ownerId: userId,
                dailySalary: dailySalary,
                members: [{ id: userId, username: interaction.user.username }],
                lastPayoutTime: Date.now(),
                password: password, // パスワードを保存
            };
            const saveSuccess = await saveCompanyDataToFirestore(companyId, newCompanyData);
            if (!saveSuccess) {
                return interaction.editReply({ content: '会社の設立中にデータベースエラーが発生しました。もう一度お試しください。', ephemeral: true });
            }
            await updateUserDataField(userId, 'companyId', companyId);
            await setUserJob(userId, "社長");
            // 新しく作成された会社の株データも初期化
            const initialStockPrice = Math.floor(Math.random() * (STOCK_PRICE_MAX - STOCK_PRICE_MIN + 1)) + STOCK_PRICE_MIN;
            await saveStockDataToFirestore(companyId, {
                ...defaultStockData,
                companyId: companyId,
                currentPrice: initialStockPrice,
                priceHistory: [{ timestamp: Date.now(), price: initialStockPrice }],
                lastUpdateTime: Date.now(),
            });
            
            const embed = new EmbedBuilder()
                .setTitle('会社設立成功！')
                .setColor('#00FF00')
                .setDescription(`会社「**${companyName}**」を設立しました！あなたが社長です。
日給: ${dailySalary.toLocaleString()} いんコイン
${password ? 'パスワードが設定されました。' : 'パスワードは設定されていません。'}
会社ID: \`${companyId}\``)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });

            const ownerDMEmbed = new EmbedBuilder()
                .setTitle('会社について')
                .setDescription(`会社の作成おめでとうございます！会社は毎日**夜9時**に維持費が引き出されます。
維持費は日給も含まれ、**日給×人数 + 300000**コインが引き落とされます。
/company depositでコインを入れて維持費を払いましょう！
日給はもちろん会社の人に支払われます。`)
                .setColor('#0099ff')
                .setTimestamp();
            try {
                await interaction.user.send({ embeds: [ownerDMEmbed] });
            } catch (dmError) {
                console.error(`Failed to send company creation DM to owner ${userId}:`, dmError);
            }

        } else if (subcommand === 'edit') { // 新しいeditコマンドの処理
            const newName = interaction.options.getString('new_name');
            const newPassword = interaction.options.getString('new_password');

            const userData = await getUserData(userId);
            if (!userData.companyId) {
                return interaction.editReply({ content: 'あなたはどの会社にも所属していません。会社に参加するか作成してください。' });
            }
            let companyData = await getCompanyData(userData.companyId);
            if (!companyData || companyData.ownerId !== userId) {
                return interaction.editReply({ content: '会社の情報を変更できるのは社長のみです。' });
            }

            if (!newName && !newPassword) {
                return interaction.editReply({ content: '新しい会社名または新しいパスワードのどちらか、あるいは両方を指定してください。' });
            }

            let updateFields = {};
            let replyMessages = [];

            if (newName) {
                const allCompanies = await getAllCompanies();
                const existingCompany = allCompanies.find(c => c.name.toLowerCase() === newName.toLowerCase() && c.id !== companyData.id);
                if (existingCompany) {
                    return interaction.editReply({ content: 'その会社名は既に存在します。別の名前を試してください。' });
                }
                updateFields.name = newName;
                replyMessages.push(`会社名を「**${newName}**」に変更しました。`);
            }
            if (newPassword !== null) { // newPasswordが明示的にnullまたは空文字列で指定された場合も含む
                updateFields.password = newPassword === '' ? null : newPassword; // 空文字列ならnullに設定
                replyMessages.push(newPassword === '' ? '会社のパスワードを削除しました。' : `会社のパスワードを更新しました。`);
            }

            const saveSuccess = await saveCompanyDataToFirestore(companyData.id, { ...companyData, ...updateFields });
            if (!saveSuccess) {
                return interaction.editReply({ content: '会社情報の更新中にデータベースエラーが発生しました。もう一度お試しください。', ephemeral: true });
            }

            const embed = new EmbedBuilder()
                .setTitle('会社情報更新完了！')
                .setColor('#00FF00')
                .setDescription(replyMessages.join('\n'))
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });

        } else if (subcommand === 'deposit') {
            const amount = interaction.options.getInteger('amount');
            const userData = await getUserData(userId);
            if (!userData.companyId) {
                return interaction.editReply({ content: 'あなたはどの会社にも所属していません。会社に参加するか作成してください。' });
            }
            const currentCoins = await getCoins(userId);
            if (currentCoins < amount) {
                return interaction.editReply({ content: `所持金が足りません！現在 ${currentCoins.toLocaleString()} いんコイン持っています。` });
            }
            const companyData = await getCompanyData(userData.companyId);
            if (!companyData || !companyData.name) {
                 await updateUserDataField(userId, 'companyId', null);
                 await setUserJob(userId, "無職");
                 return interaction.editReply({ content: '所属している会社のデータが見つかりませんでした。会社から脱退扱いになりました。再度会社に参加するか、新しい会社を作成してください。' });
            }
            await addCoins(userId, -amount);
            const updateSuccess = await updateCompanyDataField(userData.companyId, 'budget', companyData.budget + amount);
            if (!updateSuccess) {
                return interaction.editReply({ content: '会社の予算への預け入れ中にデータベースエラーが発生しました。もう一度お試しください。', ephemeral: true });
            }
            const embed = new EmbedBuilder()
                .setTitle('会社予算に預け入れ')
                .setColor('#00FF00')
                .setDescription(`${amount.toLocaleString()} いんコインを会社「${companyData.name}」の予算に預け入れました。
現在の会社予算: ${(await getCompanyData(userData.companyId)).budget.toLocaleString()} いんコイン
あなたの所持金: ${(await getCoins(userId)).toLocaleString()} いんコイン`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'withdraw') {
            const amount = interaction.options.getInteger('amount');
            const userData = await getUserData(userId);
            if (!userData.companyId) {
                return interaction.editReply({ content: 'あなたはどの会社にも所属していません。会社に参加するか作成してください。' });
            }
            const companyData = await getCompanyData(userData.companyId);
            if (companyData.ownerId !== userId) {
                return interaction.editReply({ content: '会社の予算から引き出しできるのは社長のみです。' });
            }
            if (!companyData || !companyData.name) {
                 await updateUserDataField(userId, 'companyId', null);
                 await setUserJob(userId, "無職");
                 return interaction.editReply({ content: '所属している会社のデータが見つかりませんでした。会社から脱退扱いになりました。再度会社に参加するか、新しい会社を作成してください。' });
            }
            if (companyData.budget < amount) {
                return interaction.editReply({ content: `会社の予算が足りません！現在 ${companyData.budget.toLocaleString()} いんコインが会社の予算にあります。` });
            }
            const updateSuccess = await updateCompanyDataField(userData.companyId, 'budget', companyData.budget - amount);
            if (!updateSuccess) {
                return interaction.editReply({ content: '会社の予算からの引き出し中にデータベースエラーが発生しました。もう一度お試しください。', ephemeral: true });
            }
            await addCoins(userId, amount);
            const embed = new EmbedBuilder()
                .setTitle('会社予算から引き出し')
                .setColor('#00FF00')
                .setDescription(`${amount.toLocaleString()} いんコインを会社「${companyData.name}」の予算から引き出しました。
現在の会社予算: ${(await getCompanyData(userData.companyId)).budget.toLocaleString()} いんコイン
あなたの所持金: ${(await getCoins(userId)).toLocaleString()} いんコイン`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'alldeposit') {
            const toggle = interaction.options.getBoolean('toggle');
            const userData = await getUserData(userId);
            if (!userData.companyId) {
                return interaction.editReply({ content: 'あなたはどの会社にも所属していません。会社に参加するか作成してください。' });
            }
            const companyData = await getCompanyData(userData.companyId);
            if (companyData.ownerId !== userId) {
                return interaction.editReply({ content: '自動入金を設定できるのは社長のみです。' });
            }
            if (!companyData || !companyData.name) {
                 await updateUserDataField(userId, 'companyId', null);
                 await setUserJob(userId, "無職");
                 return interaction.editReply({ content: '所属している会社のデータが見つかりませんでした。会社から脱退扱いになりました。再度会社に参加するか、新しい会社を作成してください。' });
            }
            const updateSuccess = await updateCompanyDataField(userData.companyId, 'autoDeposit', toggle);
            if (!updateSuccess) {
                return interaction.editReply({ content: '自動入金設定の変更中にデータベースエラーが発生しました。もう一度お試しください。', ephemeral: true });
            }
            const status = toggle ? 'ON' : 'OFF';
            const embed = new EmbedBuilder()
                .setTitle('自動入金設定')
                .setColor('#00FF00')
                .setDescription(`会社「${companyData.name}」のworkコマンド自動入金を **${status}** に設定しました。`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'join') {
            const companyName = interaction.options.getString('company_name');
            const providedPassword = interaction.options.getString('password'); // 提供されたパスワードを取得

            const allCompanies = await getAllCompanies();
            const targetCompany = allCompanies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
            if (!targetCompany) {
                return interaction.editReply({ content: `会社「${companyName}」は見つかりませんでした。` });
            }

            // パスワードチェック
            if (targetCompany.password && targetCompany.password !== providedPassword) {
                return interaction.editReply({ content: 'この会社はパスワードで保護されています。正しいパスワードを入力してください。' });
            }
            if (targetCompany.password && !providedPassword) {
                return interaction.editReply({ content: 'この会社はパスワードで保護されています。パスワードを入力してください。' });
            }
            if (!targetCompany.password && providedPassword) {
                 return interaction.editReply({ content: 'この会社はパスワードで保護されていません。パスワードオプションは不要です。' });
            }

            const userData = await getUserData(userId);
            if (userData.companyId) {
                const currentCompany = await getCompanyData(userData.companyId);
                return interaction.editReply({ content: `あなたは既に会社「${currentCompany.name}」に所属しています。新しい会社に参加する前に、現在の会社を抜けるか削除してください。` });
            }
            if (targetCompany.members.some(m => m.id === userId)) {
                return interaction.editReply({ content: `あなたは既に会社「${companyName}」のメンバーです。` });
            }
            const updatedMembers = [...targetCompany.members, { id: userId, username: interaction.user.username }];
            const saveSuccess = await saveCompanyDataToFirestore(targetCompany.id, { ...targetCompany, members: updatedMembers });
            if (!saveSuccess) {
                return interaction.editReply({ content: '会社への参加中にデータベースエラーが発生しました。もう一度お試しください。', ephemeral: true });
            }
            await updateUserDataField(userId, 'companyId', targetCompany.id);
            const embed = new EmbedBuilder()
                .setTitle('会社に参加成功！')
                .setColor('#00FF00')
                .setDescription(`会社「**${targetCompany.name}**」に参加しました！
日給: ${targetCompany.dailySalary.toLocaleString()} いんコイン`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'info') {
            const companyNameOption = interaction.options.getString('company_name');
            let targetCompanyData = null;
            if (companyNameOption) {
                const allCompanies = await getAllCompanies();
                targetCompanyData = allCompanies.find(c => c.name.toLowerCase() === companyNameOption.toLowerCase());
                if (!targetCompanyData) {
                    return interaction.editReply({ content: `会社「${companyNameOption}」は見つかりませんでした。` });
                }
            } else {
                const userData = await getUserData(userId);
                if (!userData.companyId) {
                    return interaction.editReply({ content: 'あなたはどの会社にも所属していません。会社に参加するか作成してください。または、会社名を指定して情報を検索してください。' });
                }
                targetCompanyData = await getCompanyData(userData.companyId);
                if (!targetCompanyData || !targetCompanyData.name) {
                     await updateUserDataField(userId, 'companyId', null);
                     await setUserJob(userId, "無職");
                     return interaction.editReply({ content: '所属している会社のデータが見つかりませんでした。会社から脱退扱いになりました。再度会社に参加するか、新しい会社を作成してください。' });
                }
            }
            const ownerUser = await client.users.fetch(targetCompanyData.ownerId).catch(() => ({ username: '不明なユーザー' }));
            const membersList = targetCompanyData.members.map(m => `- ${m.username}`).join('\n') || 'なし';
            const embed = new EmbedBuilder()
                .setTitle(`会社「${targetCompanyData.name}（日給 ${targetCompanyData.dailySalary.toLocaleString()}コイン）」の情報`)
                .setColor('#FFFF00')
                .addFields(
                    { name: '社長', value: ownerUser.username, inline: true },
                    { name: '日給', value: `${targetCompanyData.dailySalary.toLocaleString()} いんコイン`, inline: true },
                    { name: '現在の予算', value: `${targetCompanyData.budget.toLocaleString()} いんコイン`, inline: false },
                    { name: '自動入金', value: targetCompanyData.autoDeposit ? 'ON' : 'OFF', inline: true },
                    { name: 'メンバー数', value: `${targetCompanyData.members.length} 人`, inline: true },
                    { name: 'パスワード設定', value: targetCompanyData.password ? 'あり' : 'なし', inline: true }, // パスワード情報の追加
                    { name: 'メンバーリスト', value: membersList, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'delete') {
            const userData = await getUserData(userId);
            if (!userData.companyId) {
                return interaction.editReply({ content: 'あなたはどの会社にも所属していません。' });
            }
            const companyData = await getCompanyData(userData.companyId);
            if (companyData.ownerId !== userId) {
                return interaction.editReply({ content: '会社を削除できるのは社長のみです。' });
            }
            if (!companyData || !companyData.name) {
                 await updateUserDataField(userId, 'companyId', null);
                 await setUserJob(userId, "無職");
                 return interaction.editReply({ content: '所属している会社のデータが見つかりませんでした。会社から脱退扱いになりました。' });
            }
            // 会社メンバーのcompanyIdをnullにリセットし、職業を「無職」に戻す
            for (const member of companyData.members) {
                await updateUserDataField(member.id, 'companyId', null);
                await setUserJob(member.id, "無職");
            }
            await deleteCompanyFromFirestore(userData.companyId);
            const embed = new EmbedBuilder()
                .setTitle('会社削除完了')
                .setColor('#FF0000')
                .setDescription(`会社「**${companyData.name}**」を削除しました。会社のいんコインは全て消滅しました。`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'leave') {
            const userData = await getUserData(userId);
            if (!userData.companyId) {
                return interaction.editReply({ content: 'あなたはどの会社にも所属していません。' });
            }

            const companyData = await getCompanyData(userData.companyId);
            if (!companyData || !companyData.name) {
                await updateUserDataField(userId, 'companyId', null);
                await setUserJob(userId, "無職");
                return interaction.editReply({ content: '所属している会社のデータが見つかりませんでした。会社から脱退扱いになりました。' });
            }

            if (companyData.ownerId === userId) {
                return interaction.editReply({ content: 'あなたは会社の社長です。会社を辞めるには、まず `/company delete` コマンドで会社を削除するか、他のメンバーに社長を引き継いでください。' });
            }

            const updatedMembers = companyData.members.filter(member => member.id !== userId);
            const saveSuccess = await saveCompanyDataToFirestore(companyData.id, { ...companyData, members: updatedMembers });
            if (!saveSuccess) {
                return interaction.editReply({ content: '会社からの脱退中にデータベースエラーが発生しました。もう一度お試しください。', ephemeral: true });
            }

            await updateUserDataField(userId, 'companyId', null);
            await setUserJob(userId, "無職");

            const embed = new EmbedBuilder()
                .setTitle('会社を辞めました')
                .setColor('#FFD700')
                .setDescription(`あなたは会社「**${companyData.name}**」を辞めました。\nあなたの職業は「無職」に戻りました。`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            await interaction.editReply({ embeds: [embed] });
        }
    },
};
client.commands.set(companyCommand.data.name, companyCommand);

// === Stock Command ===
const stockCommand = {
    data: new SlashCommandBuilder()
        .setName('stock')
        .setDescription('会社の株を取引します。')
        .addSubcommand(subcommand =>
            subcommand
                .setName('help')
                .setDescription('株関連のコマンドヘルプを表示します。'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('ユーザーに株を付与します。(管理者のみ)')
                .addStringOption(option =>
                    option.setName('company')
                        .setDescription('株を付与する会社名')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addIntegerOption(option =>
                    option.setName('amount')
                        .setDescription('付与する株数')
                        .setRequired(true)
                        .setMinValue(1))
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('株を付与するユーザー')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('ユーザーから株を削除します。(管理者のみ)')
                .addStringOption(option =>
                    option.setName('company')
                        .setDescription('株を削除する会社名')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addIntegerOption(option =>
                    option.setName('amount')
                        .setDescription('削除する株数')
                        .setRequired(true)
                        .setMinValue(1))
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('株を削除するユーザー')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('buy')
                .setDescription('会社の株を購入します。')
                .addStringOption(option =>
                    option.setName('company')
                        .setDescription('購入したい会社名')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addIntegerOption(option =>
                    option.setName('amount')
                        .setDescription('購入する株数')
                        .setRequired(true)
                        .setMinValue(1)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('sell')
                .setDescription('会社の株を売却します。')
                .addStringOption(option =>
                    option.setName('company')
                        .setDescription('売却したい会社名')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addIntegerOption(option =>
                    option.setName('amount')
                        .setDescription('売却する株数')
                        .setRequired(true)
                        .setMinValue(1)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('info')
                .setDescription('会社の株情報を表示します。')
                .addStringOption(option =>
                    option.setName('company')
                        .setDescription('情報を表示したい会社名')
                        .setRequired(true)
                        .setAutocomplete(true))),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'help') {
            const helpEmbed = new EmbedBuilder()
                .setTitle('株コマンドヘルプ')
                .setDescription('株関連の利用可能なコマンドとその説明です。')
                .setColor('#FFD700')
                .addFields(
                    { name: '/stock add <会社名> <株数> <ユーザー>', value: '管理者のみ、指定したユーザーに会社の株を付与します。', inline: false },
                    { name: '/stock remove <会社名> <株数> <ユーザー>', value: '管理者のみ、指定したユーザーから会社の株を削除します。', inline: false },
                    { name: '/stock buy <会社名> <株数>', value: '会社の株を購入します。', inline: false },
                    { name: '/stock sell <会社名> <株数>', value: '会社の株を売却します。', inline: false },
                    { name: '/stock info <会社名>', value: '指定した会社の現在の株価と過去1時間の推移を表示します。', inline: false },
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [helpEmbed] });
        } else if (subcommand === 'add') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
            }
            const companyName = interaction.options.getString('company');
            const amount = interaction.options.getInteger('amount');
            const targetUser = interaction.options.getUser('user');

            const allCompanies = await getAllCompanies();
            const targetCompany = allCompanies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
            if (!targetCompany) {
                return interaction.editReply({ content: `会社「${companyName}」は見つかりませんでした。` });
            }

            await addUserStocks(targetUser.id, targetCompany.id, amount);
            const embed = new EmbedBuilder()
                .setTitle('株付与完了')
                .setColor('#00FF00')
                .setDescription(`${targetUser.username} に会社「${targetCompany.name}」の株を **${amount.toLocaleString()}** 株付与しました。`)
                .addFields(
                    { name: `${targetUser.username} の株保有数`, value: `会社「${targetCompany.name}」: ${(await getUserStocks(targetUser.id, targetCompany.id)).toLocaleString()} 株`, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'remove') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
            }
            const companyName = interaction.options.getString('company');
            const amount = interaction.options.getInteger('amount');
            const targetUser = interaction.options.getUser('user');

            const allCompanies = await getAllCompanies();
            const targetCompany = allCompanies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
            if (!targetCompany) {
                return interaction.editReply({ content: `会社「${companyName}」は見つかりませんでした。` });
            }

            const userCurrentStocks = await getUserStocks(targetUser.id, targetCompany.id);
            if (userCurrentStocks < amount) {
                return interaction.editReply({ content: `${targetUser.username} は会社「${targetCompany.name}」の株を **${amount.toLocaleString()}** 株保有していません。（現在: ${userCurrentStocks.toLocaleString()} 株）` });
            }

            await addUserStocks(targetUser.id, targetCompany.id, -amount);
            const embed = new EmbedBuilder()
                .setTitle('株削除完了')
                .setColor('#FF0000')
                .setDescription(`${targetUser.username} から会社「${targetCompany.name}」の株を **${amount.toLocaleString()}** 株削除しました。`)
                .addFields(
                    { name: `${targetUser.username} の株保有数`, value: `会社「${targetCompany.name}」: ${(await getUserStocks(targetUser.id, targetCompany.id)).toLocaleString()} 株`, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'buy') {
            const companyName = interaction.options.getString('company');
            const amount = interaction.options.getInteger('amount');

            const allCompanies = await getAllCompanies();
            const targetCompany = allCompanies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
            if (!targetCompany) {
                return interaction.editReply({ content: `会社「${companyName}」は見つかりませんでした。` });
            }

            const stockData = await getStockData(targetCompany.id);
            if (!stockData || !stockData.currentPrice) {
                return interaction.editReply({ content: `会社「${targetCompany.name}」の株価情報が見つかりませんでした。` });
            }
            const currentPrice = stockData.currentPrice;
            const totalCost = amount * currentPrice;
            const userCoins = await getCoins(userId);

            if (userCoins < totalCost) {
                return interaction.editReply({ content: `いんコインが足りません！**${amount.toLocaleString()}** 株購入するには **${totalCost.toLocaleString()}** いんコイン必要ですが、あなたは **${userCoins.toLocaleString()}** いんコインしか持っていません。` });
            }

            await addCoins(userId, -totalCost);
            await addUserStocks(userId, targetCompany.id, amount);

            const embed = new EmbedBuilder()
                .setTitle('株購入完了')
                .setColor('#00FF00')
                .setDescription(`会社「${targetCompany.name}」の株を **${amount.toLocaleString()}** 株購入しました。
費用: **${totalCost.toLocaleString()}** いんコイン（@${currentPrice.toLocaleString()} いんコイン/株）`)
                .addFields(
                    { name: 'あなたの所持金', value: `${(await getCoins(userId)).toLocaleString()} いんコイン`, inline: false },
                    { name: `あなたの ${targetCompany.name} 株保有数`, value: `${(await getUserStocks(userId, targetCompany.id)).toLocaleString()} 株`, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });

        } else if (subcommand === 'sell') {
            const companyName = interaction.options.getString('company');
            const amount = interaction.options.getInteger('amount');

            const allCompanies = await getAllCompanies();
            const targetCompany = allCompanies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
            if (!targetCompany) {
                return interaction.editReply({ content: `会社「${companyName}」は見つかりませんでした。` });
            }

            const stockData = await getStockData(targetCompany.id);
            if (!stockData || !stockData.currentPrice) {
                return interaction.editReply({ content: `会社「${targetCompany.name}」の株価情報が見つかりませんでした。` });
            }
            const currentPrice = stockData.currentPrice;
            const userCurrentStocks = await getUserStocks(userId, targetCompany.id);

            if (userCurrentStocks < amount) {
                return interaction.editReply({ content: `会社「${targetCompany.name}」の株を **${amount.toLocaleString()}** 株保有していません。（現在: ${userCurrentStocks.toLocaleString()} 株）` });
            }

            const totalEarnings = amount * currentPrice;
            await addCoins(userId, totalEarnings);
            await addUserStocks(userId, targetCompany.id, -amount);

            const embed = new EmbedBuilder()
                .setTitle('株売却完了')
                .setColor('#00FF00')
                .setDescription(`会社「${targetCompany.name}」の株を **${amount.toLocaleString()}** 株売却しました。
収益: **${totalEarnings.toLocaleString()}** いんコイン（@${currentPrice.toLocaleString()} いんコイン/株）`)
                .addFields(
                    { name: 'あなたの所持金', value: `${(await getCoins(userId)).toLocaleString()} いんコイン`, inline: false },
                    { name: `あなたの ${targetCompany.name} 株保有数`, value: `${(await getUserStocks(userId, targetCompany.id)).toLocaleString()} 株`, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'info') {
            const companyName = interaction.options.getString('company');

            const allCompanies = await getAllCompanies();
            const targetCompany = allCompanies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
            if (!targetCompany) {
                return interaction.editReply({ content: `会社「${companyName}」は見つかりませんでした。` });
            }

            const stockData = await getStockData(targetCompany.id);
            if (!stockData || !stockData.currentPrice) {
                return interaction.editReply({ content: `会社「${targetCompany.name}」の株価情報が見つかりませんでした。` });
            }

            const priceHistory = stockData.priceHistory.sort((a, b) => a.timestamp - b.timestamp);
            let chart = '';
            if (priceHistory.length > 1) {
                const minPrice = Math.min(...priceHistory.map(entry => entry.price));
                const maxPrice = Math.max(...priceHistory.map(entry => entry.price));
                const range = maxPrice - minPrice;

                // グラフの高さを決定 (例: 5行)
                const chartHeight = 5;

                // 各時点の価格をグラフのY軸にマッピング
                priceHistory.forEach((entry, index) => {
                    const priceNormalized = range === 0 ? 0 : (entry.price - minPrice) / range;
                    const chartPosition = Math.floor(priceNormalized * (chartHeight - 1));
                    let line = ' '.repeat(chartHeight); // 5文字の空白
                    line = line.substring(0, chartHeight - 1 - chartPosition) + '█' + line.substring(chartHeight - chartPosition);
                    chart += `${line} ${entry.price.toLocaleString()} (${new Date(entry.timestamp).getMinutes()}分)\n`;
                });
                chart = `\`\`\`\n${chart}\n\`\`\``;
            } else if (priceHistory.length === 1) {
                chart = `過去1時間のデータが不足しています。現在の価格: ${stockData.currentPrice.toLocaleString()} いんコイン`;
            } else {
                chart = '現在、株価履歴データがありません。';
            }

            const embed = new EmbedBuilder()
                .setTitle(`会社「${targetCompany.name}」の株価情報`)
                .setColor('#FFD700')
                .addFields(
                    { name: '現在の株価', value: `${stockData.currentPrice.toLocaleString()} いんコイン`, inline: false },
                    { name: '過去1時間 (10分ごと)', value: chart, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        }
    },
};
client.commands.set(stockCommand.data.name, stockCommand);

const pingCommand = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Botの応答時間をテストします。'),
    default_member_permissions: null,
    async execute(interaction) {
        const ping = client.ws.ping;
        await interaction.editReply(`Pong! (${ping}ms)`);
    },
};
client.commands.set(pingCommand.data.name, pingCommand);

const echoCommand = {
    data: new SlashCommandBuilder()
        .setName('echo')
        .setDescription('入力したメッセージを繰り返します。(管理者のみ)')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('繰り返したいメッセージ')
                .setRequired(true)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }
        const message = interaction.options.getString('message');
        // /echo コマンドの最初の応答は一時的
        await interaction.editReply({ content: '正常に動作しました。\n(このメッセージはあなただけに表示されています)', ephemeral: true });
        await interaction.channel.send(message);
    },
};
client.commands.set(echoCommand.data.name, echoCommand);

const senddmCommand = {
    data: new SlashCommandBuilder()
        .setName('senddm')
        .setDescription('指定したユーザーにBot経由でDMを送信します。')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('DMを送信するユーザー')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('message')
                .setDescription('送信するメッセージ')
                .setRequired(true)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }
        const target = interaction.options.getMember('target');
        const message = interaction.options.getString('message');
        try {
            await target.send(message);
            await interaction.editReply({ content: `<@${target.id}>にDMを送信しました。` });
        } catch (error) {
            await interaction.editReply({ content: 'DMの送信に失敗しました。' });
            console.error(error);
        }
    },
};
client.commands.set(senddmCommand.data.name, senddmCommand);

const authPanelCommand = {
    data: new SlashCommandBuilder()
        .setName('auth-panel')
        .setDescription('認証パネルをチャンネルに表示します。')
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('認証後に付与するロールを指定します。')
                .setRequired(true)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }
        const authRoleOption = interaction.options.getRole('role');
        if (!authRoleOption) {
            await interaction.editReply({ content: '認証パネルを送信するには、付与するロールを指定する必要があります。' });
            return;
        }
        await interaction.editReply({
            content: '認証パネルをチャンネルに送信しました。'
        });
        const roleToAssign = authRoleOption.id;
        const authButton = new ButtonBuilder()
            .setCustomId(`auth_start_${roleToAssign}`)
            .setLabel('認証')
            .setStyle(ButtonStyle.Primary);
        const actionRow = new ActionRowBuilder().addComponents(authButton);
        const authEmbed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('認証')
            .setDescription('こちらから認証をお願いします。');
        await interaction.channel.send({
            embeds: [authEmbed],
            components: [actionRow],
        });
    },
};
client.commands.set(authPanelCommand.data.name, authPanelCommand);

const authCommand = {
    data: new SlashCommandBuilder()
        .setName('auth')
        .setDescription('認証コードを入力して認証を完了します。')
        .addStringOption(option =>
            option.setName('code')
                .setDescription('DMに送信された認証コード')
                .setRequired(true)),
    default_member_permissions: null,
    async execute(interaction) {
        const code = interaction.options.getString('code');
        const userId = interaction.user.id;
        const authData = authChallenges.get(userId);
        if (!authData) {
            return interaction.editReply({
                content: '認証リクエストが見つかりません。まずサーバーで認証ボタンを押してください。',
                ephemeral: true // auth command should be ephemeral
            });
        }
        if (Date.now() - authData.timestamp > 3 * 60 * 1000) {
            authChallenges.delete(userId);
            return interaction.editReply({
                content: '有効な認証コードが見当たりません。もう一度認証ボタンからやり直してください。',
                ephemeral: true // auth command should be ephemeral
            });
        }
        if (authData.code === code) {
            const guild = client.guilds.cache.get(authData.guildId);
            if (!guild) {
                return interaction.editReply({ content: '認証したサーバーが見つかりません。', ephemeral: true });
            }
            const member = await guild.members.fetch(userId);
            const authRole = guild.roles.cache.get(authData.roleToAssign);
            if (member && authRole) {
                await member.roles.add(authRole);
                authChallenges.delete(userId);
                return interaction.editReply({
                    content: `認証に成功しました！ ${authRole.name} ロールを付与しました。`,
                    ephemeral: true // auth command should be ephemeral
                });
            } else {
                return interaction.editReply({
                    content: '認証は成功しましたが、ロールを付与できませんでした。サーバー管理者に連絡してください。',
                    ephemeral: true // auth command should be ephemeral
                });
            }
        } else {
            return interaction.editReply({
                content: '認証コードが正しくありません。もう一度お試しください。',
                ephemeral: true // auth command should be ephemeral
            });
        }
    },
};
client.commands.set(authCommand.data.name, authCommand);

const helpCommand = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Botのコマンド一覧を表示します。'),
    default_member_permissions: null,
    async execute(interaction) {
        const helpEmbed = new EmbedBuilder()
            .setTitle('Bot Commands List')
            .setDescription('利用可能なコマンドとその説明です。')
            .setColor('ADFF2F')
            .addFields(
                { name: '/ping', value: 'Botの応答時間をテストします。', inline: false },
                { name: '/echo <message>', value: '入力したメッセージを繰り返します。(管理者のみ)', inline: false },
                { name: '/senddm <target> <message>', value: '指定したユーザーにDMを送信します。(管理者のみ)', inline: false },
                { name: '/auth-panel <role>', value: '認証パネルをチャンネルに表示し、ボタンで認証を開始します。付与するロールの指定は必須です。このコマンドは管理者権限が必要です。', inline: false },
                { name: '/auth <code>', value: 'DMで送信された認証コードを入力して認証を完了します。', inline: false },
                { name: '/ticket-panel <category> <role1> [role2] [role3] [role4]', value: 'チケットパネルをチャンネルに表示し、チケット作成ボタンを設置します。チケットチャンネルは指定されたカテゴリーに作成され、指定したロールに閲覧権限が付与されます。', inline: false },
                { name: '/money help', value: 'いんコイン関連のコマンドヘルプを表示します。', inline: false },
                { name: '/company help', value: '会社関連のコマンドヘルプを表示します。', inline: false },
                { name: '/stock help', value: '株関連のコマンドヘルプを表示します。', inline: false }, // ヘルプに追加
                { name: '/help', value: 'このコマンド一覧を表示します。', inline: false }
            );
        await interaction.editReply({ embeds: [helpEmbed] });
    },
};
client.commands.set(helpCommand.data.name, helpCommand);

const ticketPanelCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-panel')
        .setDescription('チケットパネルをチャンネルに表示します。')
        .addChannelOption(option =>
            option.setName('category')
                .setDescription('チケットチャンネルを作成するカテゴリー')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildCategory))
        .addRoleOption(option =>
            option.setName('role1')
                .setDescription('チケット閲覧権限を付与する必須ロール')
                .setRequired(true))
        .addRoleOption(option =>
            option.setName('role2')
                .setDescription('チケット閲覧権限を付与する任意ロール')
                .setRequired(false))
        .addRoleOption(option =>
            option.setName('role3')
                .setDescription('チケット閲覧権限を付与する任意ロール')
                .setRequired(false))
        .addRoleOption(option =>
            option.setName('role4')
                .setDescription('チケット閲覧権限を付付与する任意ロール')
                .setRequired(false)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }
        const ticketCategory = interaction.options.getChannel('category');
        const rolesToAssign = [
            interaction.options.getRole('role1')?.id,
            interaction.options.getRole('role2')?.id,
            interaction.options.getRole('role3')?.id,
            interaction.options.getRole('role4')?.id,
        ].filter(id => id);
        if (!ticketCategory || rolesToAssign.length === 0) {
            return interaction.editReply({ content: 'チケットパネルを送信するには、カテゴリーと最低1つのロールを指定する必要があります。' });
        }
        const panelId = Math.random().toString(36).substring(7);
        ticketPanels.set(panelId, { categoryId: ticketCategory.id, roles: rolesToAssign });
        await interaction.editReply({
            content: 'チケットパネルをチャンネルに送信しました。'
        });
        const ticketButton = new ButtonBuilder()
            .setCustomId(`ticket_create_${panelId}`)
            .setLabel('チケットを作成')
            .setStyle(ButtonStyle.Success);
        const actionRow = new ActionRowBuilder().addComponents(ticketButton);
        const rolesMention = rolesToAssign.map(id => `<@&${id}>`).join(', ');
        const ticketEmbed = new EmbedBuilder()
            .setColor('#32CD32')
            .setTitle('チケットが開かれました')
            .setDescription(`サポートが必要な内容をこちらに記入してください。担当者が対応します。
このチャンネルは、あなたと ${rolesMention} のみに表示されています。`);
        await interaction.channel.send({
            embeds: [ticketEmbed],
            components: [actionRow]
        });
    },
};
client.commands.set(ticketPanelCommand.data.name, ticketPanelCommand);


async function registerCommands() {
    // ギルド（サーバー）限定コマンド
    const guildCommandsData = [
        registerCommand.data.toJSON(),
        gamblingCommand.data.toJSON(),
        moneyCommand.data.toJSON(),
        workCommand.data.toJSON(),
        robCommand.data.toJSON(),
        giveMoneyCommand.data.toJSON(),
        addMoneyCommand.data.toJSON(),
        removeMoneyCommand.data.toJSON(),
        channelMoneyCommand.data.toJSON(),
        loadCommand.data.toJSON(),
        depositCommand.data.toJSON(),
        withdrawCommand.data.toJSON(),
        jobsCommand.data.toJSON(),
        jobChangeCommand.data.toJSON(),
        companyCommand.data.toJSON(),
        stockCommand.data.toJSON(), // 新しいstockコマンドを登録
    ];

    // グローバルコマンド
    const globalCommandsData = [
        pingCommand.data.toJSON(),
        echoCommand.data.toJSON(),
        senddmCommand.data.toJSON(),
        authPanelCommand.data.toJSON(),
        authCommand.data.toJSON(),
        helpCommand.data.toJSON(),
        ticketPanelCommand.data.toJSON(),
    ];

    const rest = new REST().setToken(DISCORD_TOKEN);

    try {
        if (GUILD_ID) {
            console.log(`Registering ${guildCommandsData.length} guild-specific commands for guild ${GUILD_ID}.`);
            await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: guildCommandsData });
            console.log('Guild-specific commands successfully registered.');
        } else {
            console.warn('GUILD_ID is not set. Guild-specific commands will not be registered.');
        }

        console.log(`Registering ${globalCommandsData.length} global commands.`);
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: globalCommandsData });
        console.log('Global commands successfully registered.');

    } catch (error) {
        console.error("Failed to register commands:", error);
    }
}

client.once('ready', async () => {
    console.log(`Ready! Logged in as ${client.user.tag}`);

    // Firebase Configuration (Canvas環境が優先、なければ.envから読み込み)
    // process.env.FIREBASE_CONFIG が undefined の場合、空のJSON文字列 '{}' を使用してエラーを回避
    const firebaseConfig = typeof __firebase_config !== 'undefined' 
        ? JSON.parse(__firebase_config) 
        : JSON.parse(process.env.FIREBASE_CONFIG || '{}'); // ここを修正

    // Firebase初期化
    firebaseApp = initializeApp(firebaseConfig);
    db = getFirestore(firebaseApp);
    auth = getAuth(firebaseApp);

    if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token.length > 0) {
        try {
            await signInWithCustomToken(auth, __initial_auth_token);
            firebaseAuthUid = auth.currentUser.uid;
            console.log(`Firebase authenticated with custom token as: ${firebaseAuthUid}`);
        } catch (error) {
            console.error("Error signing in with custom token, signing in anonymously:", error);
            await signInAnonymously(auth);
            firebaseAuthUid = auth.currentUser.uid;
            console.log(`Firebase authenticated anonymously as: ${firebaseAuthUid}`);
        }
    } else {
        await signInAnonymously(auth);
        firebaseAuthUid = auth.currentUser.uid;
        console.log(`Firebase authenticated anonymously as: ${firebaseAuthUid}`);
    }

    // コマンド登録
    await registerCommands();
    client.user.setPresence({
        activities: [{
            name: `/help`,
            type: ActivityType.Playing,
        }],
        status: 'online',
    });
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        // /echo 以外のコマンドはデフォルトで公開応答
        const isEphemeralCommand = interaction.commandName === 'echo' || interaction.commandName === 'auth'; 
        await interaction.deferReply({ ephemeral: isEphemeralCommand }).catch(error => {
            console.error("Failed to defer reply:", error);
            return;
        });
    }

    if (!interaction.deferred && !interaction.replied && interaction.isChatInputCommand()) {
        return;
    }

    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);

        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            // 不明なコマンドは常に一時的に返信
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content: '不明なコマンドです！', ephemeral: true });
            } else {
                return interaction.reply({ content: '不明なコマンドです！', ephemeral: true });
            }
        }

        try {
            if (command.default_member_permissions && interaction.member && !interaction.member.permissions.has(command.default_member_permissions)) {
                return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。', ephemeral: true });
            }
            
            const nonAdminMoneyCommands = ['gambling', 'money', 'work', 'rob', 'give-money', 'deposit', 'withdraw', 'jobs', 'job-change', 'load', 'company', 'stock'];
            const isCompanyAddCommand = interaction.commandName === 'company' && interaction.options.getSubcommand() === 'add';

            if (nonAdminMoneyCommands.includes(interaction.commandName) && interaction.commandName !== 'register' && !isCompanyAddCommand) {
                const userData = await getUserData(interaction.user.id);
                if (!userData.isRegistered) {
                    return interaction.editReply({ content: 'このコマンドを使用するには、まず `/register` コマンドでいんコインシステムに登録してください。', ephemeral: true });
                }
            }

            await command.execute(interaction);

            const userId = interaction.user.id;
            const creditPoints = await getCreditPoints(userId); 
            const punishedForNegativeCredit = await getUserPunishedForNegativeCredit(userId); 
            if (creditPoints < 0 && !punishedForNegativeCredit) {
                const guild = interaction.guild;
                if (guild) {
                    const member = await guild.members.fetch(userId).catch(() => null);
                    if (member) {
                        const initialBankCoins = await getBankCoins(userId); 
                        const initialCurrentCoins = await getCoins(userId); 
                        const totalAvailableCoins = initialBankCoins + initialCurrentCoins;

                        if (totalAvailableCoins <= 0) {
                            console.log(`User ${userId} has 0 or negative total coins, skipping negative credit penalty.`);
                            return; 
                        }

                        const deductionPercentage = Math.floor(Math.random() * (90 - 75 + 1)) + 75;
                        let intendedTotalDeduction = Math.floor(totalAvailableCoins * (deductionPercentage / 100));

                        if (intendedTotalDeduction < 0) intendedTotalDeduction = 0;

                        let deductedFromBank = 0;
                        let deductedFromCurrent = 0;
                        let dmMessage = '';
                        let actualTotalDeducted = 0;

                        if (initialBankCoins > 0) {
                            deductedFromBank = Math.min(initialBankCoins, intendedTotalDeduction);
                            await addBankCoins(userId, -deductedFromBank); 
                            actualTotalDeducted += deductedFromBank;
                        }
                        
                        const remainingPenaltyToDeduct = intendedTotalDeduction - deductedFromBank;
                        if (remainingPenaltyToDeduct > 0) { 
                            deductedFromCurrent = Math.min(initialCurrentCoins, remainingPenaltyToDeduct);
                            await addCoins(userId, -deductedFromCurrent); 
                            actualTotalDeducted += deductedFromCurrent;
                        }

                        if (actualTotalDeducted > 0) {
                            if (deductedFromBank > 0 && deductedFromCurrent > 0) {
                                dmMessage = `信用ポイントが負になったため、銀行残高から **${deductedFromBank.toLocaleString()}** いんコイン、さらに所持金から **${deductedFromCurrent.toLocaleString()}** いんコインが差し引かれました。`;
                            } else if (deductedFromBank > 0) {
                                dmMessage = `信用ポイントが負になったため、銀行残高から **${deductedFromBank.toLocaleString()}** いんコインが差し引かれました。`;
                            } else if (deductedFromCurrent > 0) {
                                dmMessage = `信用ポイントが負になったため、銀行に残高がなかったため所持金から **${deductedFromCurrent.toLocaleString()}** いんコインが差し引かれました。`;
                            }
                        } else {
                            dmMessage = `信用ポイントが負になりましたが、いんコインが少なかったため、差し引かれたいんコインはありませんでした。`;
                        }

                        await updateUserDataField(userId, 'creditPoints', -10); 
                        await setUserPunishedForNegativeCredit(userId, true); 

                        const dmEmbed = new EmbedBuilder()
                            .setTitle('信用ポイント低下による処罰')
                            .setDescription(`${dmMessage}
あなたの現在の所持金は **${(await getCoins(userId)).toLocaleString()}** いんコインです。
あなたの銀行残高は現在 **${(await getBankCoins(userId)).toLocaleString()}** いんコインです。
信用ポイントは **${(await getCreditPoints(userId))}** にリセットされました。`) 
                            .setColor('#FF0000')
                            .setTimestamp();
                        
                        try {
                            await member.send({ embeds: [dmEmbed] });
                        } catch (dmError) {
                            console.error(`Failed to send DM to ${member.user.tag}:`, dmError);
                        }
                    }
                }
            }

        } catch (error) {
            console.error(`Error executing command ${interaction.commandName}:`, error);
            // コマンド実行中のエラーも一時的に返信
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: 'コマンドの実行中にエラーが発生しました！', ephemeral: true });
            } else {
                await interaction.reply({ content: 'コマンドの実行中にエラーが発生しました！', ephemeral: true });
            }
        }
    } else if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'jobs' && interaction.options.getSubcommand() === 'assign') {
            const focusedOption = interaction.options.getFocused(true);
            if (focusedOption.name === 'job_name') {
                const filtered = Array.from(jobSettings.keys()).filter(choice =>
                    choice.toLowerCase().startsWith(focusedOption.value.toLowerCase()) && choice !== "社長"
                );
                if ("無職".toLowerCase().startsWith(focusedOption.value.toLowerCase())) {
                    if (!filtered.includes("無職")) {
                        filtered.unshift("無職");
                    }
                }
                await interaction.respond(
                    filtered.map(choice => ({ name: choice, value: choice }))
                );
            }
        } else if (interaction.commandName === 'job-change') {
            const focusedOption = interaction.options.getFocused(true);
            if (focusedOption.name === 'job_name') {
                const filtered = Array.from(jobSettings.keys()).filter(choice =>
                    choice.toLowerCase().startsWith(focusedOption.value.toLowerCase()) && choice !== "社長"
                );
                if ("無職".toLowerCase().startsWith(focusedOption.value.toLowerCase())) {
                    if (!filtered.includes("無職")) {
                        filtered.unshift("無職");
                    }
                }
                await interaction.respond(
                    filtered.map(choice => ({ name: choice, value: choice }))
                );
            }
        } else if (interaction.commandName === 'company' && (interaction.options.getSubcommand() === 'join' || interaction.options.getSubcommand() === 'info')) {
            const focusedOption = interaction.options.getFocused(true);
            if (focusedOption.name === 'company_name') {
                const allCompanies = await getAllCompanies();
                const filtered = allCompanies.filter(company =>
                    company.name.toLowerCase().startsWith(focusedOption.value.toLowerCase())
                ).map(company => ({ name: `${company.name}（日給 ${company.dailySalary.toLocaleString()}コイン）`, value: company.name }));
                await interaction.respond(filtered);
            }
        } else if (interaction.commandName === 'stock' && (interaction.options.getSubcommand() === 'add' || interaction.options.getSubcommand() === 'remove' || interaction.options.getSubcommand() === 'buy' || interaction.options.getSubcommand() === 'sell' || interaction.options.getSubcommand() === 'info')) {
            const focusedOption = interaction.options.getFocused(true);
            if (focusedOption.name === 'company') {
                const allCompanies = await getAllCompanies();
                const filtered = allCompanies.filter(company =>
                    company.name.toLowerCase().startsWith(focusedOption.value.toLowerCase())
                ).map(company => ({ name: `${company.name} (株価: ${(stockDataCache.get(company.id)?.currentPrice || defaultStockData.currentPrice).toLocaleString()}いんコイン)`, value: company.name }));
                await interaction.respond(filtered);
            }
        }
    } else if (interaction.isButton()) {
        try {
            if (interaction.customId.startsWith('auth_start_')) {
                await interaction.deferReply({ ephemeral: true });
                
                const [_, __, roleToAssign] = interaction.customId.split('_');
                
                const member = interaction.guild.members.cache.get(interaction.user.id);
                if (member && member.roles.cache.has(roleToAssign)) {
                    return interaction.editReply({ content: 'あなたは既に認証されています。', ephemeral: true });
                }

                const num1 = Math.floor(Math.random() * (30 - 10 + 1)) + 10;
                const num2 = Math.floor(Math.random() * (60 - 31 + 1)) + 31;
                
                const authCode = (num1 + num2).toString();
                const equation = `${num1} + ${num2}`;
                
                authChallenges.set(interaction.user.id, {
                    code: authCode,
                    equation: equation,
                    guildId: interaction.guild.id,
                    roleToAssign: roleToAssign,
                    timestamp: Date.now()
                });

                const dmEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('認証コード')
                    .setDescription(`認証コードを送信しました。認証番号は以下の数式の答えです。
有効時間は3分です。

**${equation}**

この数式の答えを認証番号として、DMで \`/auth 認証番号\` と入力してください。`);
                
                try {
                    await interaction.user.send({ embeds: [dmEmbed] });
                    await interaction.editReply({
                        content: '認証コードをDMに送信しました。ご確認ください。',
                        ephemeral: true
                    });
                } catch (error) {
                    console.error('DM送信中にエラーが発生しました:', error);
                    authChallenges.delete(interaction.user.id);
                    await interaction.editReply({
                        content: 'DMの送信に失敗しました。DM設定をご確認ください。',
                        ephemeral: true
                    });
                }
            } else if (interaction.customId.startsWith('ticket_create_')) {
                await interaction.deferReply({ ephemeral: true });

                const [_, __, panelId] = interaction.customId.split('_');
                const panelConfig = ticketPanels.get(panelId);

                if (!panelConfig) {
                    return interaction.editReply({ content: 'このチケットパネルは無効です。再度作成してください。', ephemeral: true });
                }

                const { categoryId, roles } = panelConfig;
                const guild = interaction.guild;
                const member = interaction.member;

                if (!guild || !member) {
                    return interaction.editReply({ content: 'この操作はサーバー内でのみ実行可能です。', ephemeral: true });
                }

                const existingTicketChannel = guild.channels.cache.find(c =>
                    c.name.startsWith(`ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '')}`) &&
                    c.parentId === categoryId
                );

                if (existingTicketChannel) {
                    return interaction.editReply({
                        content: `あなたはすでにチケットを持っています: ${existingTicketChannel}`,
                        ephemeral: true
                    });
                }
                
                const channelName = `ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;

                const permissionOverwrites = [
                    {
                        id: guild.id,
                        deny: [PermissionsBitField.Flags.ViewChannel],
                    },
                    {
                        id: member.id,
                        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
                    },
                    {
                        id: client.user.id,
                        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
                    },
                ];
                
                roles.forEach(roleId => {
                    if (roleId) {
                        permissionOverwrites.push({
                            id: roleId,
                            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
                        });
                    }
                    else {
                        console.warn(`Invalid roleId found in panelConfig.roles for panelId: ${panelId}`);
                    }
                });

                try {
                    const newChannel = await guild.channels.create({
                        name: channelName,
                        type: ChannelType.GuildText,
                        parent: categoryId,
                        permissionOverwrites: permissionOverwrites,
                    });

                    const closeButton = new ButtonBuilder()
                            .setCustomId('ticket_close')
                            .setLabel('終了')
                            .setStyle(ButtonStyle.Danger);

                    const actionRow = new ActionRowBuilder().addComponents(closeButton);

                    const rolesMention = roles.map(id => `<@&${id}>`).join(', ');

                    const ticketEmbed = new EmbedBuilder()
                        .setColor('#32CD32')
                        .setTitle('チケットが開かれました')
                        .setDescription(`サポートが必要な内容をこちらに記入してください。担当者が対応します。
このチャンネルは、あなたと ${rolesMention} のみに表示されています。`);

                    await newChannel.send({
                        content: `${member}`,
                        embeds: [ticketEmbed],
                        components: [actionRow]
                    });

                    await interaction.editReply({
                        content: `チケットが作成されました: ${newChannel}`,
                        ephemeral: true
                    });

                } catch (error) {
                    console.error('チケットチャンネルの作成中にエラーが発生しました:', error);
                    await interaction.editReply({ content: 'チケットの作成に失敗しました。', ephemeral: true });
                }
            } else if (interaction.customId === 'ticket_close') {
                await interaction.deferReply({ ephemeral: true }); // チケットクローズも一時的
                try {
                    await interaction.editReply({ content: 'チケットを終了します。このチャンネルは数秒後に削除されます。', ephemeral: true });
                    setTimeout(() => {
                        interaction.channel.delete('チケットが終了されました');
                    }, 3000);
                } catch (error) {
                    console.error('チケットチャンネルの削除中にエラーが発生しました:', error);
                    await interaction.editReply({ content: 'チケットの削除に失敗しました。', ephemeral: true });
                }
            }
        } catch (error) {
            console.error('ボタン処理中にエラーが発生しました:', error);
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({ content: 'ボタンの実行中にエラーが発生しました！', ephemeral: true });
            } else {
                await interaction.reply({ content: 'ボタンの実行中にエラーが発生しました！', ephemeral: true });
            }
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    const channelId = message.channel.id;
    // チャンネル報酬設定をFirestoreから取得するように変更
    const rewardConfig = await getChannelRewardData(channelId);

    if (rewardConfig && rewardConfig.min !== 0 && rewardConfig.max !== 0) { // min/maxが0でないことを確認
        let earnedAmount = Math.floor(Math.random() * (rewardConfig.max - rewardConfig.min + 1)) + rewardConfig.min;

        const creditPoints = await getCreditPoints(message.author.id); 
        if (creditPoints < 0) {
            earnedAmount = Math.floor(earnedAmount * 0.30);
            if (earnedAmount < 0) earnedAmount = 0; 
        }

        await addCoins(message.author.id, earnedAmount);
    }
});

client.login(DISCORD_TOKEN);
