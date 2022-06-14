import { expect } from "chai";
import hre, { deployments, waffle } from "hardhat";
import "@nomiclabs/hardhat-ethers";
import { AddressZero } from "@ethersproject/constants";
import { parseEther } from "@ethersproject/units";
import { defaultAbiCoder } from "@ethersproject/abi";
import { getSafeWithOwners, getCompatFallbackHandler } from "../utils/setup";
import { buildSignatureBytes, signHash} from "../../src/utils/execution";


describe("NestedSafes", async () => {
    const [user1, user2, user3, user4, user5] = waffle.provider.getWallets();
    
    const setupTests = deployments.createFixture(async ({ deployments }) => {
        await deployments.fixture();
        const handler = await getCompatFallbackHandler()
        const safe1 = await getSafeWithOwners([user1.address, user2.address], 2, handler.address)
        const safe2 = await getSafeWithOwners([user3.address, user4.address], 2, handler.address)
        const parentSafe = await getSafeWithOwners([safe1.address, safe2.address], 2, handler.address)
        const handlerSafe1 = handler.attach(safe1.address)
        const handlerSafe2 = handler.attach(safe2.address)
        return {
            safe1,
            safe2,
            parentSafe, 
            handlerSafe1,
            handlerSafe2
        }
    })

    it('should use EIP-1271 (contract signatures)', async () => {
        const { safe1, safe2, parentSafe,handlerSafe1,handlerSafe2 } = await setupTests()
        // Deposit some spare money for execution to owner safes
        await expect(await hre.ethers.provider.getBalance(safe1.address)).to.be.equal(0)
        await user1.sendTransaction({to: safe1.address, value: parseEther("1")})
        await expect(await hre.ethers.provider.getBalance(safe1.address)).to.be.equal(parseEther("1"))
        
        await expect(await hre.ethers.provider.getBalance(safe2.address)).to.be.equal(0)
        await user1.sendTransaction({to: safe2.address, value: parseEther("1")})
        await expect(await hre.ethers.provider.getBalance(safe2.address)).to.be.equal(parseEther("1"))

        await expect(await hre.ethers.provider.getBalance(parentSafe.address)).to.be.equal(0)
        await user1.sendTransaction({to: parentSafe.address, value: parseEther("1")})
        await expect(await hre.ethers.provider.getBalance(parentSafe.address)).to.be.equal(parseEther("1"))

        // Withdraw 1 ETH
        const to = user5.address
        const value = parseEther("1")
        const data = "0x"
        const operation = 0
        const nonce = await parentSafe.nonce()
        const messageData = await parentSafe.encodeTransactionData(to, value, data, operation, 0, 0, 0, AddressZero, AddressZero, nonce)
        
        // Get hash transaction for each safe
        const messageHashSafe1 = await handlerSafe1.getMessageHashForSafe(safe1.address,messageData)
        const messageHashSafe2 = await handlerSafe2.getMessageHashForSafe(safe2.address,messageData)
        // Get all signs for each owner Safe1 (user1, user2) Safe2 (user3, user4)
        const sig1 = await signHash(user1, messageHashSafe1)
        const sig2 = await signHash(user2, messageHashSafe1)
        const sig3 = await signHash(user3, messageHashSafe2)
        const sig4 = await signHash(user4, messageHashSafe2)
        let signSafe1 =  buildSignatureBytes([sig1, sig2])
        let signSafe2 =  buildSignatureBytes([sig3, sig4])
        
       
        // Check if signature for each safe is correct
        expect(await handlerSafe1.callStatic['isValidSignature(bytes,bytes)'](messageData, signSafe1)).to.be.eq("0x20c13b0b")
        expect(await handlerSafe2.callStatic['isValidSignature(bytes,bytes)'](messageData, signSafe2)).to.be.eq("0x20c13b0b")

        let staticPart = "0x"
        // Pack signatures in correct order
        if (safe1.address < safe2.address) {
            staticPart += "000000000000000000000000" + safe1.address.slice(2) + "0000000000000000000000000000000000000000000000000000000000000082" + "00" // r, s, v
            staticPart += "000000000000000000000000" + safe2.address.slice(2) + "0000000000000000000000000000000000000000000000000000000000000142" + "00" // r, s, v
        } else {
            staticPart += "000000000000000000000000" + safe2.address.slice(2) + "0000000000000000000000000000000000000000000000000000000000000142" + "00" // r, s, v
            staticPart += "000000000000000000000000" + safe1.address.slice(2) + "0000000000000000000000000000000000000000000000000000000000000082" + "00" // r, s, v
        }

        
        let dynamicPart = 
        defaultAbiCoder.encode(['bytes'], [signSafe1]).slice(66)+
        defaultAbiCoder.encode(['bytes'], [signSafe2]).slice(66)

        let signature = staticPart + dynamicPart
        // Should execute transaction withdraw 1 ether
        expect(await parentSafe.execTransaction(to, value, data, operation, 0, 0, 0, AddressZero, AddressZero, signature)).to.be.ok
        // Should be 0 
        await expect(await hre.ethers.provider.getBalance(parentSafe.address)).to.be.deep.eq(parseEther("0"))
    })

});