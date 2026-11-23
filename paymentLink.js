const axios = require('axios');
const https = require('https');
const agent = new https.Agent({
    keepAlive: true,
    rejectUnauthorized: false,
    secureProtocol: 'TLSv1_2_method'
});

const paymentLink = async (playerId) => {
    try {
        const playerUrl = 'https://shop.garena.my/api/auth/player_id_login';
        const playerPostFields = {
            app_id: 100067,
            login_id: playerId,
            app_server_id: 0
        };
        const playerHeaders = {
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Cookie': 'source=pc; mspid2=23b79d8125f5d8ad091c745a0d28fc05; _ga=GA1.2.1526106606.1721112559; _gid=GA1.2.1406809970.1721112561; session_key=cs8kp6w6nasib8qle25wdk1m6or5dkb1; datadome=p9~L6eqQcvvFfaMp4ZJdJ7~nehAlDMS45slODUxjnAT~tdSm6UUQU6V9WxfSABNVZVUQLOIV889OYVz6DXBh6UIm8jeailbgL5z2ZDzpFz~pAMUx5dOKyk0675bTqUyT; __csrf__=ZTRZ38n7xT4jbYgpZpp6Rc5obiUZtcpd; _ga_76GMJR9HMM=GS1.1.1721112559.1.1.1721112624.0.0.0',
            'DNT': '1',
            'Origin': 'https://shop.garena.my',
            'Pragma': 'no-cache',
            'Referer': 'https://shop.garena.my/app',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Sec-Fetch-User': '?1',
            'Sec-GPC': '1',
            'X-Requested-With': 'XMLHttpRequest',
            'sec-ch-ua': '"Chromium";v="92", " Not A;Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'x-datadome-clientid': 'p9~L6eqQcvvFfaMp4ZJdJ7~nehAlDMS45slODUxjnAT~tdSm6UUQU6V9WxfSABNVZVUQLOIV889OYVz6DXBh6UIm8jeailbgL5z2ZDzpFz~pAMUx5dOKyk0675bTqUyT',
        };

        const playerResponse = await axios.post(playerUrl, playerPostFields, { headers: playerHeaders, httpsAgent: agent });
        const playerData = playerResponse.data;

        if (!playerData.nickname || playerData.region !== 'BD') {
            return 'Invalid player ID';
        }

        const paymentUrl = 'https://shop.garena.my/api/shop/pay/init?language=en&region=MY';
        const paymentPostFields = {
            service: 'pc',
            app_id: 100067,
            packed_role_id: 0,
            channel_id: 221179,
            channel_data: {
                payment_channel: null,
                need_return: true,
                invoice: []
            },
            revamp_experiment: {
                session_id: '7f99fd8d48e7aecb7cedaa4a204b305f',
                group: 'control2',
                service_version: 'payment_center_frontend_20240611',
                source: 'pc',
                domain: 'shop.garena.my'
            }
        };
        const paymentHeaders = {
            ...playerHeaders,
            'X-CSRF-Token': 'ZTRZ38n7xT4jbYgpZpp6Rc5obiUZtcpd'
        };

        const paymentResponse = await axios.post(paymentUrl, paymentPostFields, { headers: paymentHeaders, httpsAgent: agent });
        const paymentData = paymentResponse.data;

        if (!paymentData.init || !paymentData.init.url) {
            return 'Failed to initiate payment';
        }

        return paymentData.init.url;

    } catch (error) {
        console.error('Error occurred:', error.message);
        return error.message; // Re-throw the error to be caught by the caller
    }
};

module.exports = { paymentLink };
