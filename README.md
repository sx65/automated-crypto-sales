# Discord Crypto Payment Bot

A Discord bot that processes USDT payments and delivers digital product keys. This bot allows users to purchase digital products using USDT on the Ethereum network directly within your Discord server.

## Features

- 💰 **Cryptocurrency Payments**: Accept USDT (ERC-20) payments directly
- 🔑 **Automatic Product Key Delivery**: Generate and deliver product keys upon payment
- 📱 **QR Code Generation**: Easy payments via QR code scanning
- 🛡️ **Role Assignment**: Automatically assign roles to customers after purchase
- 📊 **Transaction Tracking**: Monitor payment status in real-time
- 📝 **Detailed Audit Logs**: Keep track of all actions and transactions
- 🔐 **Admin Commands**: Admin-only commands for transaction management
- ⏱️ **Anti-Spam Protection**: Cooldown system to prevent abuse

## Setup

### Prerequisites

- Node.js (v14 or higher)
- Discord Bot Token
- Ethereum Wallet Address
- Etherscan API Key

### Installation

1. Clone this repository:
   ```
   git clone https://github.com/sx65/automated-crypto-sales.git
   cd automated-crypto-sales
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create a `.env` file with the following variables:
   ```
   DISCORD_TOKEN=your_discord_bot_token
   MERCHANT_ADDRESS=your_ethereum_wallet_address
   ETHERSCAN_API_KEY=your_etherscan_api_key
   ```

4. Start the bot:
   ```
   node index.js
   ```

## Usage

### User Commands

- `/purchase` - Initiate a purchase of the product

### Admin Commands

- `/transaction [id]` - View details of a specific transaction

### Buttons

- **View Transaction** - See transaction details
- **Copy Address** - Copy the payment address
- **Copy Amount** - Copy the exact payment amount
- **Cancel Transaction** (Admin only) - Cancel a pending transaction
- **Resend Key** (Admin only) - Resend a product key to a user

## Configuration

You can modify the following variables in the code to customize the bot:

- `product_price` - Base price of the product in USDT
- `tracking_fee` - Small fee added to make each transaction amount unique
- `cooldown_time` - Time users must wait between purchases (in milliseconds)

## Database

The bot uses SQLite to store:

- Transactions
- Audit logs
- User cooldowns
- Used payment amounts

## How It Works

1. User initiates purchase with `/purchase` command
2. Bot generates a unique transaction ID and payment amount
3. User receives payment instructions with QR code
4. Bot monitors the blockchain for incoming payments
5. Upon payment detection, a product key is generated and sent to the user
6. User receives the "Product Owner" role in the server

## Transaction Lifecycle

- **Pending**: Payment requested but not yet received
- **Completed**: Payment received and product key delivered
- **Expired**: 30-minute payment window elapsed with no payment
- **Cancelled**: Transaction cancelled by an administrator

## License

[MIT License](LICENSE)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Disclaimer

This software is provided "as is", without warranty of any kind. Use at your own risk. The developer is not responsible for any loss of funds or other issues that may occur when using this bot.
